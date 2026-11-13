import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../../shared/domain/money";
import { LedgerDirection } from "../../domain/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import mikroOrmConfig from "../../../shared/infrastructure/database/mikro-orm.config";
import { WalletConcurrencyError } from "./persistence-errors";
import { walletLedgerEntryFromRow } from "./row-mappers";
import { executeRows, executeStatement } from "./sql";
import { MikroOrmWageringUnitOfWork } from "./wagering-unit-of-work";
import { WageringTx } from "../../application/ports/wagering-unit-of-work";

const now = new Date("2026-04-05T06:07:08.000Z");
const later = new Date("2026-04-06T06:07:08.000Z");

let orm: MikroORM;

function getOrm(): MikroORM {
  if (!orm) {
    throw new Error("The PostgreSQL persistence test has not initialized MikroORM.");
  }

  return orm;
}

function createTransactionProps(
  walletId: string,
  playerId: string,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): Parameters<typeof WagerTransaction.create>[0] {
  return {
    id: randomUUID(),
    providerId: `provider-${randomUUID()}`,
    externalTransactionId: `external-${randomUUID()}`,
    idempotencyKey: `idempotency-${randomUUID()}`,
    payloadHash: "payload-hash",
    walletId,
    playerId,
    roundId: "round/free-form",
    gameId: "game/free-form",
    kind: WagerTransactionKind.BET,
    money: Money.from({ amount: "0.10", currency: "BRL" }),
    createdAt: now,
    ...overrides,
  };
}

async function runInWageringTransaction<T>(
  work: (tx: WageringTx) => Promise<T>,
): Promise<T> {
  return new MikroOrmWageringUnitOfWork(getOrm().em).run(work);
}

describe("MikroORM wagering persistence", () => {
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it("round-trips wallets and saves with an expected version", async () => {
    await runInWageringTransaction(async (tx) => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: randomUUID(),
        initialBalance: Money.from({ amount: "0.10", currency: "BRL" }),
        at: now,
      });

      await tx.wallets.insert(wallet);
      const loaded = await tx.wallets.findByIdForUpdate(wallet.id);

      expect(loaded?.balance.toString()).toBe("0.10");
      expect(loaded?.version).toBe(1);
      expect(loaded?.playerId).toBe(wallet.playerId);

      if (loaded === undefined) {
        throw new Error("Inserted wallet was not found for update.");
      }

      loaded.credit(
        Money.from({ amount: "0.01", currency: "BRL" }),
        randomUUID(),
        randomUUID(),
        later,
      );
      await tx.wallets.save(loaded, 1);

      const saved = await tx.wallets.findByIdForUpdate(wallet.id);
      expect(saved?.balance.toString()).toBe("0.11");
      expect(saved?.version).toBe(2);
      expect(saved?.updatedAt).toEqual(later);
    });
  });

  it("rejects wallet saves when the expected version is stale", async () => {
    await expect(
      runInWageringTransaction(async (tx) => {
        const wallet = Wallet.open({
          id: randomUUID(),
          playerId: randomUUID(),
          initialBalance: Money.from({ amount: "1.00", currency: "BRL" }),
          at: now,
        });
        await tx.wallets.insert(wallet);
        await tx.wallets.save(wallet, 0);
      }),
    ).rejects.toThrow(WalletConcurrencyError);
  });

  it("round-trips wager transactions and saves observed balances", async () => {
    await runInWageringTransaction(async (tx) => {
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance: Money.from({ amount: "1.00", currency: "BRL" }),
        at: now,
      });
      await tx.wallets.insert(wallet);

      const transaction = WagerTransaction.create(
        createTransactionProps(wallet.id, playerId),
      );
      await tx.transactions.insert(transaction);

      transaction.markProcessed(undefined, later);
      await tx.transactions.save(
        transaction,
        Money.from({ amount: "0.90", currency: "BRL" }),
      );

      const byIdempotency = await tx.transactions.findByIdempotencyKeyOrExternalId(
        "different-provider",
        "different-external-id",
        transaction.idempotencyKey,
      );
      const byExternalId = await tx.transactions.findByIdempotencyKeyOrExternalId(
        transaction.providerId,
        transaction.externalTransactionId,
        "different-idempotency-key",
      );

      expect(byIdempotency?.transaction.money.toString()).toBe("0.10");
      expect(byIdempotency?.transaction.roundId).toBe("round/free-form");
      expect(byIdempotency?.transaction.gameId).toBe("game/free-form");
      expect(byExternalId?.transaction.id).toBe(transaction.id);
      expect(byIdempotency?.observedBalance?.toString()).toBe("0.90");

      const saved = await tx.transactions.findByIdempotencyKeyOrExternalId(
        transaction.providerId,
        transaction.externalTransactionId,
        transaction.idempotencyKey,
      );
      expect(saved?.transaction.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(saved?.transaction.processedAt).toEqual(later);
      expect(saved?.transaction.failureCode).toBeUndefined();
      expect(saved?.observedBalance?.toString()).toBe("0.90");
    });
  });

  it("round-trips ledger entries", async () => {
    const persisted = await runInWageringTransaction(async (tx) => {
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        initialBalance: Money.from({ amount: "1.00", currency: "BRL" }),
        at: now,
      });
      const transaction = WagerTransaction.create(
        createTransactionProps(wallet.id, playerId),
      );
      const entry = wallet.debit(
        transaction.money,
        transaction.id,
        randomUUID(),
        later,
      );

      await tx.wallets.insert(wallet);
      await tx.transactions.insert(transaction);
      await tx.ledger.insert(entry);

      return { transaction, entry };
    });

    const rows = await executeRows(
      getOrm().em.fork(),
      `SELECT ledger.id, ledger.wallet_id, ledger.transaction_id, ledger.direction,
              ledger.amount_cents, ledger.balance_before_cents,
              ledger.balance_after_cents, ledger.created_at, wallets.currency
       FROM wallet_ledger_entries AS ledger
       JOIN wallets ON wallets.id = ledger.wallet_id
       WHERE ledger.transaction_id = ?`,
      [persisted.transaction.id],
    );
    expect(rows).toHaveLength(1);

    const persistedEntry = walletLedgerEntryFromRow(rows[0]!);
    expect(persistedEntry.id).toBe(persisted.entry.id);
    expect(persistedEntry.money.toString()).toBe("0.10");
    expect(persistedEntry.balanceBefore.toString()).toBe("1.00");
    expect(persistedEntry.balanceAfter.toString()).toBe("0.90");
    expect(persistedEntry.direction).toBe(LedgerDirection.DEBIT);
    expect(persistedEntry.isBalanced()).toBe(true);
  });

  it("rejects ledger updates in PostgreSQL", async () => {
    const walletId = randomUUID();
    const transactionId = randomUUID();
    const entryId = randomUUID();
    const playerId = randomUUID();
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: "1.00", currency: "BRL" }),
      at: now,
    });
    const transaction = WagerTransaction.create(
      createTransactionProps(walletId, playerId, {
        id: transactionId,
      }),
    );
    const entry = wallet.debit(
      transaction.money,
      transaction.id,
      entryId,
      later,
    );

    await runInWageringTransaction(async (tx) => {
      await tx.wallets.insert(wallet);
      await tx.transactions.insert(transaction);
      await tx.ledger.insert(entry);
    });

    await expect(
      executeStatement(
        getOrm().em.fork(),
        "UPDATE wallet_ledger_entries SET amount_cents = ? WHERE id = ?",
        ["11", entryId],
      ),
    ).rejects.toThrow("wallet_ledger_entries is append-only");
  });

  it("enqueues and reads a JSON outbox payload", async () => {
    const aggregateId = randomUUID();
    const payload = {
      walletId: aggregateId,
      amount: Money.from({ amount: "0.10", currency: "BRL" }).toJSON(),
    };

    await runInWageringTransaction(async (tx) => {
      await tx.outbox.enqueue({
        aggregateType: "Wallet",
        aggregateId,
        eventType: "WalletBalanceChanged",
        payload,
      });
    });

    const rows = await executeRows(
      getOrm().em.fork(),
      `SELECT aggregate_type, aggregate_id, event_type, payload
       FROM outbox_messages
       WHERE aggregate_id = ?`,
      [aggregateId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_type).toBe("Wallet");
    expect(rows[0]?.event_type).toBe("WalletBalanceChanged");
    expect(rows[0]?.payload).toEqual(payload);
  });
});
