import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { EntityManager } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../shared/infrastructure/database/mikro-orm.config";
import { FailureCode } from "../domain/errors";
import { WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { CreateWalletUseCase } from "./create-wallet.use-case";
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from "./errors";
import { SubmitWagerTransactionInput, SubmitWagerTransactionUseCase } from "./submit-wager-transaction.use-case";
import { Clock, IdGenerator, WageringTx } from "./ports/wagering-unit-of-work";
import { BunIdGenerator } from "../infrastructure/runtime/bun-id-generator";
import { executeRows, requiredString } from "../infrastructure/database/sql";
import { MikroOrmWageringUnitOfWork } from "../infrastructure/database/wagering-unit-of-work";

const fixedTime = new Date("2026-11-12T12:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(fixedTime);
  }
}

let orm: MikroORM;
let ids: IdGenerator;
let clock: Clock;
let createWallet: CreateWalletUseCase;
let submitWager: SubmitWagerTransactionUseCase;
let unitOfWork: MikroOrmWageringUnitOfWork;

function getOrm(): MikroORM {
  if (orm === undefined) {
    throw new Error("The use-case integration test has not initialized MikroORM.");
  }

  return orm;
}

function createRequest(
  wallet: Wallet,
  overrides: Partial<SubmitWagerTransactionInput> = {},
): SubmitWagerTransactionInput {
  const suffix = Bun.randomUUIDv7();
  return {
    providerId: "provider-integration",
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-integration",
    gameId: "game-integration",
    kind: WagerTransactionKind.BET,
    money: { amount: "1.00", currency: wallet.currency },
    ...overrides,
  };
}

async function assertWalletMatchesLedger(walletId: string): Promise<void> {
  const rows = await executeRows(
    getOrm().em.fork(),
    `SELECT wallets.balance_cents::text AS wallet_cents,
            COALESCE(
              SUM(
                CASE wallet_ledger_entries.direction
                  WHEN 'CREDIT' THEN wallet_ledger_entries.amount_cents
                  ELSE -wallet_ledger_entries.amount_cents
                END
              ),
              0
            )::text AS ledger_cents
     FROM wallets
     LEFT JOIN wallet_ledger_entries ON wallet_ledger_entries.wallet_id = wallets.id
     WHERE wallets.id = ?
     GROUP BY wallets.id, wallets.balance_cents`,
    [walletId],
  );
  expect(rows).toHaveLength(1);
  expect(BigInt(requiredString(rows[0]!, "wallet_cents"))).toBe(
    BigInt(requiredString(rows[0]!, "ledger_cents")),
  );
}

async function readEvents(
  walletId: string,
  transactionId: string,
): Promise<Array<{ event_type: string; payload: unknown }>> {
  const em: EntityManager = getOrm().em.fork();
  const rows = await executeRows(
    em,
    `SELECT event_type, payload
     FROM outbox_messages
     WHERE aggregate_id = ?
       AND payload->'data'->>'transactionId' = ?
     ORDER BY created_at`,
    [walletId, transactionId],
  );

  return rows.map((row) => ({
    event_type: requiredString(row, "event_type"),
    payload: row.payload,
  }));
}

async function readTransaction(
  input: SubmitWagerTransactionInput,
): Promise<Awaited<ReturnType<WageringTx["transactions"]["findByIdempotencyKeyOrExternalId"]>>> {
  return unitOfWork.run((tx) =>
    tx.transactions.findByIdempotencyKeyOrExternalId(
      input.providerId,
      input.externalTransactionId,
      input.idempotencyKey,
    ),
  );
}

async function ledgerCount(transactionId: string, direction?: string): Promise<number> {
  const rows = await executeRows(
    getOrm().em.fork(),
    `SELECT COUNT(*)::text AS count
     FROM wallet_ledger_entries
     WHERE transaction_id = ?
       AND (?::text IS NULL OR direction = ?)`,
    [transactionId, direction ?? null, direction ?? null],
  );
  return Number(requiredString(rows[0]!, "count"));
}

async function ledgerCountForWallet(
  walletId: string,
  direction: string,
): Promise<number> {
  const rows = await executeRows(
    getOrm().em.fork(),
    `SELECT COUNT(*)::text AS count
     FROM wallet_ledger_entries
     WHERE wallet_id = ? AND direction = ?`,
    [walletId, direction],
  );
  return Number(requiredString(rows[0]!, "count"));
}

async function walletTupleId(walletId: string): Promise<string> {
  const rows = await executeRows(
    getOrm().em.fork(),
    "SELECT xmin::text AS tuple_id FROM wallets WHERE id = ?",
    [walletId],
  );
  return requiredString(rows[0]!, "tuple_id");
}

describe("wagering application use cases", () => {
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    ids = new BunIdGenerator();
    clock = new FixedClock();
    unitOfWork = new MikroOrmWageringUnitOfWork(orm.em);
    createWallet = new CreateWalletUseCase(unitOfWork, clock, ids);
    submitWager = new SubmitWagerTransactionUseCase(unitOfWork, clock, ids);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it("processes a BET and atomically records its ledger and integration events", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const input = createRequest(wallet, {
      money: { amount: "25.00", currency: "BRL" },
    });

    const result = await submitWager.execute(input);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.idempotentReplay).toBe(false);
    const persistedWallet = await unitOfWork.run((tx) =>
      tx.wallets.findByIdForUpdate(wallet.id),
    );
    expect(persistedWallet?.version).toBe(2);
    expect(await ledgerCount(result.transactionId, "DEBIT")).toBe(1);
    const transactionEvents = await readEvents(wallet.id, result.transactionId);
    expect(transactionEvents.map((row) => row.event_type).sort())
      .toEqual(["WalletBalanceChanged", "WagerTransactionProcessed"].sort());
    expect(
      transactionEvents.find((row) => row.event_type === "WagerTransactionProcessed")
        ?.payload,
    ).toMatchObject({
      eventType: "WagerTransactionProcessed",
      occurredAt: fixedTime.toISOString(),
      version: 1,
      data: { money: { amount: "25.00", currency: "BRL" } },
    });
    await assertWalletMatchesLedger(wallet.id);
  });

  it("persists insufficient-funds rejection without changing the wallet", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "0.00", currency: "BRL" },
    });
    const input = createRequest(wallet, {
      money: { amount: "1.00", currency: "BRL" },
    });

    const result = await submitWager.execute(input);

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(result.balance).toEqual({ amount: "0.00", currency: "BRL" });
    expect((await unitOfWork.run((tx) => tx.wallets.findByIdForUpdate(wallet.id)))?.version)
      .toBe(1);
    expect(await ledgerCount(result.transactionId)).toBe(0);
    expect((await readEvents(wallet.id, result.transactionId)).map((row) => row.event_type))
      .toEqual(["WagerTransactionRejected"]);
    await assertWalletMatchesLedger(wallet.id);
  });

  it("replays an identical request without adding ledger or outbox rows", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const input = createRequest(wallet, {
      money: { amount: "2.00", currency: "BRL" },
    });

    const first = await submitWager.execute(input);
    const beforeReplayEvents = (await readEvents(wallet.id, first.transactionId)).length;
    const replay = await submitWager.execute(input);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(await ledgerCount(first.transactionId)).toBe(1);
    expect((await readEvents(wallet.id, first.transactionId)).length).toBe(beforeReplayEvents);
    await assertWalletMatchesLedger(wallet.id);
  });

  it("replays the originally observed balance after later wallet changes", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const firstInput = createRequest(wallet, {
      money: { amount: "80.00", currency: "BRL" },
    });
    const first = await submitWager.execute(firstInput);
    await submitWager.execute(
      createRequest(wallet, { money: { amount: "10.00", currency: "BRL" } }),
    );

    const replay = await submitWager.execute(firstInput);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual({ amount: "20.00", currency: "BRL" });
    expect((await unitOfWork.run((tx) => tx.wallets.findByIdForUpdate(wallet.id)))?.balance.toString())
      .toBe("10.00");
    await assertWalletMatchesLedger(wallet.id);
  });

  it("rejects a reused idempotency key with a different payload", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const input = createRequest(wallet);
    await submitWager.execute(input);

    await expect(
      submitWager.execute({
        ...input,
        money: { amount: "2.00", currency: "BRL" },
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("credits WIN and records LOSS without a ledger or balance change event", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const winInput = createRequest(wallet, {
      kind: WagerTransactionKind.WIN,
      money: { amount: "5.00", currency: "BRL" },
    });
    const win = await submitWager.execute(winInput);
    expect(win.balance).toEqual({ amount: "15.00", currency: "BRL" });
    expect(await ledgerCount(win.transactionId, "CREDIT")).toBe(1);
    await assertWalletMatchesLedger(wallet.id);

    const tupleBeforeLoss = await walletTupleId(wallet.id);
    const versionBeforeLoss = (await unitOfWork.run((tx) =>
      tx.wallets.findByIdForUpdate(wallet.id),
    ))?.version;
    const loss = await submitWager.execute(
      createRequest(wallet, {
        kind: WagerTransactionKind.LOSS,
        money: { amount: "1.00", currency: "BRL" },
      }),
    );

    expect(loss.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(loss.balance).toEqual({ amount: "15.00", currency: "BRL" });
    expect(await walletTupleId(wallet.id)).toBe(tupleBeforeLoss);
    expect((await unitOfWork.run((tx) => tx.wallets.findByIdForUpdate(wallet.id)))?.version)
      .toBe(versionBeforeLoss);
    expect(await ledgerCount(loss.transactionId)).toBe(0);
    expect((await readEvents(wallet.id, loss.transactionId)).map((row) => row.event_type))
      .toEqual(["WagerTransactionProcessed"]);
    await assertWalletMatchesLedger(wallet.id);
  });

  it("persists player and currency mismatches as rejected transactions", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    const playerMismatch = createRequest(wallet, {
      playerId: Bun.randomUUIDv7(),
    });
    const playerResult = await submitWager.execute(playerMismatch);
    expect(playerResult.status).toBe(WagerTransactionStatus.REJECTED);
    expect(playerResult.failureCode).toBe(FailureCode.PLAYER_MISMATCH);
    expect((await readTransaction(playerMismatch))?.transaction.failureCode)
      .toBe(FailureCode.PLAYER_MISMATCH);

    const currencyMismatch = createRequest(wallet, {
      money: { amount: "1.00", currency: "USD" },
    });
    const currencyResult = await submitWager.execute(currencyMismatch);
    expect(currencyResult.status).toBe(WagerTransactionStatus.REJECTED);
    expect(currencyResult.failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
    expect(currencyResult.balance).toEqual({ amount: "10.00", currency: "BRL" });
    expect((await readTransaction(currencyMismatch))?.observedBalance.currency).toBe("BRL");
    await assertWalletMatchesLedger(wallet.id);
  });

  it("throws for a missing wallet without persisting transaction or outbox data", async () => {
    const input: SubmitWagerTransactionInput = {
      providerId: "provider-integration",
      externalTransactionId: `external-${Bun.randomUUIDv7()}`,
      idempotencyKey: `key-${Bun.randomUUIDv7()}`,
      playerId: Bun.randomUUIDv7(),
      walletId: Bun.randomUUIDv7(),
      roundId: "round-missing",
      gameId: "game-missing",
      kind: WagerTransactionKind.BET,
      money: { amount: "1.00", currency: "BRL" },
    };

    await expect(submitWager.execute(input)).rejects.toThrow(WalletNotFoundError);
    const transactionRows = await executeRows(
      getOrm().em.fork(),
      "SELECT id FROM wager_transactions WHERE idempotency_key = ?",
      [input.idempotencyKey],
    );
    const outboxRows = await executeRows(
      getOrm().em.fork(),
      "SELECT id FROM outbox_messages WHERE aggregate_id = ?",
      [input.walletId],
    );
    expect(transactionRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it("creates positive-balance wallets with an OPENING transaction, ledger, and events", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "12.34", currency: "BRL" },
    });
    const opening = await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        "internal",
        wallet.id,
        `opening:${wallet.id}`,
      ),
    );

    expect(wallet.version).toBe(1);
    expect(opening?.transaction.kind).toBe(WagerTransactionKind.OPENING);
    expect(opening?.transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(await ledgerCount(opening!.transaction.id, "CREDIT")).toBe(1);
    expect((await readEvents(wallet.id, opening!.transaction.id)).map((row) => row.event_type).sort())
      .toEqual(["WalletBalanceChanged", "WagerTransactionProcessed"].sort());
    await assertWalletMatchesLedger(wallet.id);
  });

  it("creates zero-balance wallets without OPENING, ledger, or outbox rows", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "0.00", currency: "BRL" },
    });
    const rows = await executeRows(
      getOrm().em.fork(),
      `SELECT
         (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ?)::text AS transaction_count,
         (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::text AS ledger_count,
         (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ?)::text AS outbox_count`,
      [wallet.id, wallet.id, wallet.id],
    );

    expect(rows[0]?.transaction_count).toBe("0");
    expect(rows[0]?.ledger_count).toBe("0");
    expect(rows[0]?.outbox_count).toBe("0");
    await assertWalletMatchesLedger(wallet.id);
  });

  it("rejects duplicate player and currency wallets", async () => {
    const playerId = Bun.randomUUIDv7();
    await createWallet.execute({
      playerId,
      initialBalance: { amount: "1.00", currency: "BRL" },
    });

    await expect(
      createWallet.execute({
        playerId,
        initialBalance: { amount: "2.00", currency: "BRL" },
      }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });

  it("serializes concurrent bets on one wallet so only one can spend the balance", async () => {
    const wallet = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const firstInput = createRequest(wallet, {
      money: { amount: "80.00", currency: "BRL" },
    });
    const secondInput = createRequest(wallet, {
      money: { amount: "80.00", currency: "BRL" },
    });

    const results = await Promise.all([
      submitWager.execute(firstInput),
      submitWager.execute(secondInput),
    ]);

    expect(
      results.filter((result) => result.status === WagerTransactionStatus.PROCESSED),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === WagerTransactionStatus.REJECTED),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === WagerTransactionStatus.REJECTED)?.failureCode,
    ).toBe(FailureCode.INSUFFICIENT_FUNDS);
    const persistedWallet = await unitOfWork.run((tx) =>
      tx.wallets.findByIdForUpdate(wallet.id),
    );
    expect(persistedWallet?.balance.toString()).toBe("20.00");
    expect(persistedWallet?.version).toBe(2);
    expect(await ledgerCountForWallet(wallet.id, "DEBIT")).toBe(1);
    await assertWalletMatchesLedger(wallet.id);
  });
});
