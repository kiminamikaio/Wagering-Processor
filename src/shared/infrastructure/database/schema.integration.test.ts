import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { EntityManager } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "./mikro-orm.config";

interface WalletInput {
  id?: string;
  playerId?: string;
  currency?: string;
  balanceCents?: string;
  version?: string;
}

interface WagerInput {
  id?: string;
  walletId: string;
  playerId?: string | null;
  roundId?: string | null;
  gameId?: string | null;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  kind?: string;
  status?: string;
  amountCents?: string;
  observedBalanceCents?: string | null;
  currency?: string;
  referenceTransactionId?: string;
  referenceExternalTransactionId?: string | null;
  failureCode?: string | null;
}

interface LedgerInput {
  walletId: string;
  transactionId: string;
  direction?: string;
  amountCents?: string;
  balanceBeforeCents?: string;
  balanceAfterCents?: string;
}

type TestOperation = (em: EntityManager) => Promise<void>;

let orm: MikroORM;

async function execute(
  em: EntityManager,
  sql: string,
  params: (string | null)[] = [],
): Promise<Record<string, unknown>[]> {
  return em.getConnection().execute(
    sql,
    params,
    "all",
    em.getTransactionContext(),
  );
}

function getOrm(): MikroORM {
  if (!orm) {
    throw new Error("The PostgreSQL integration test has not initialized MikroORM.");
  }

  return orm;
}

async function insertWallet(em: EntityManager, input: WalletInput = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  const params = [
    id,
    input.playerId ?? randomUUID(),
    input.currency ?? "USD",
    input.balanceCents ?? "0",
  ];

  if (input.version === undefined) {
    await execute(
      em,
      "INSERT INTO wallets (id, player_id, currency, balance_cents) VALUES (?, ?, ?, ?)",
      params,
    );
  } else {
    await execute(
      em,
      "INSERT INTO wallets (id, player_id, currency, balance_cents, version) VALUES (?, ?, ?, ?, ?)",
      [...params, input.version],
    );
  }

  return id;
}

async function insertWager(em: EntityManager, input: WagerInput): Promise<string> {
  const id = input.id ?? randomUUID();

  await execute(
    em,
    `INSERT INTO wager_transactions (
      id, wallet_id, player_id, round_id, game_id, provider_id,
      external_transaction_id, idempotency_key, payload_hash, kind, status,
      amount_cents, currency, observed_balance_cents, reference_transaction_id,
      reference_external_transaction_id, failure_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, '')::uuid, ?, ?)`,
    [
      id,
      input.walletId,
      input.playerId === undefined ? randomUUID() : input.playerId,
      input.roundId === undefined ? "test-round" : input.roundId,
      input.gameId === undefined ? "test-game" : input.gameId,
      input.providerId ?? randomUUID(),
      input.externalTransactionId ?? randomUUID(),
      input.idempotencyKey ?? randomUUID(),
      input.payloadHash ?? "test-payload-hash",
      input.kind ?? "BET",
      input.status ?? "PENDING",
      input.amountCents ?? "1",
      input.currency ?? "USD",
      input.observedBalanceCents === undefined ? null : input.observedBalanceCents,
      input.referenceTransactionId ?? "",
      input.referenceExternalTransactionId === undefined
        ? null
        : input.referenceExternalTransactionId,
      input.failureCode === undefined ? null : input.failureCode,
    ],
  );

  return id;
}

async function insertLedger(em: EntityManager, input: LedgerInput): Promise<void> {
  await execute(
    em,
    `INSERT INTO wallet_ledger_entries (
      wallet_id, transaction_id, direction, amount_cents,
      balance_before_cents, balance_after_cents
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.walletId,
      input.transactionId,
      input.direction ?? "CREDIT",
      input.amountCents ?? "1",
      input.balanceBeforeCents ?? "0",
      input.balanceAfterCents ?? "1",
    ],
  );
}

async function expectConstraintFailure(
  constraintName: string,
  operation: TestOperation,
): Promise<void> {
  await expect(getOrm().em.transactional(operation)).rejects.toThrow(constraintName);
}

async function withRollback(operation: TestOperation): Promise<void> {
  const rollbackSignal = new Error("Rollback integration test data.");

  try {
    await getOrm().em.transactional(async (em) => {
      await operation(em);
      throw rollbackSignal;
    });
  } catch (error) {
    if (error !== rollbackSignal) {
      throw error;
    }
  }
}

describe("PostgreSQL schema constraints", () => {
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it("uses BIGINT for every cents column and defaults wallet version to 1", async () => {
    await withRollback(async (em) => {
      const walletId = await insertWallet(em);
      const walletRows = await execute(
        em,
        "SELECT balance_cents, version FROM wallets WHERE id = ?",
        [walletId],
      );
      const balanceCents = walletRows[0]?.balance_cents;

      expect(typeof balanceCents).toBe("string");
      if (typeof balanceCents !== "string") {
        throw new Error("PostgreSQL BIGINT should be returned as a string.");
      }
      expect(BigInt(balanceCents)).toBe(BigInt("0"));
      expect(walletRows[0]?.version).toBe(1);

      const monetaryColumns = await execute(
        em,
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name IN (
             'wallets',
             'wager_transactions',
             'wallet_ledger_entries'
           )
           AND column_name LIKE '%\\_cents' ESCAPE '\\'`,
      );
      expect(monetaryColumns.length).toBe(6);
      expect(monetaryColumns.every((column) => column.data_type === "bigint")).toBe(true);

      const wagerId = await insertWager(em, { walletId });
      const referenceAttempts = await execute(
        em,
        "SELECT reference_attempts FROM wager_transactions WHERE id = ?",
        [wagerId],
      );
      expect(referenceAttempts[0]?.reference_attempts).toBe(0);
    });
  });

  it("enforces unique wallet per player and currency", async () => {
    await expectConstraintFailure("wallets_player_currency_unique", async (em) => {
      const playerId = randomUUID();
      await insertWallet(em, { playerId });
      await insertWallet(em, { playerId });
    });
  });

  it("rejects negative wallet balances", async () => {
    await expectConstraintFailure("wallets_balance_non_negative", async (em) => {
      await insertWallet(em, { balanceCents: "-1" });
    });
  });

  it("requires wallet versions to start at one or greater", async () => {
    await expectConstraintFailure("wallets_version_positive", async (em) => {
      await insertWallet(em, { version: "0" });
    });
  });

  it("enforces unique provider transaction identifiers", async () => {
    await expectConstraintFailure(
      "wager_transactions_provider_external_transaction_unique",
      async (em) => {
        const walletId = await insertWallet(em);
        const providerId = randomUUID();
        const externalTransactionId = randomUUID();
        await insertWager(em, { walletId, providerId, externalTransactionId });
        await insertWager(em, { walletId, providerId, externalTransactionId });
      },
    );
  });

  it("requires player, round, and game identifiers on wagers", async () => {
    for (const missingField of ["playerId", "roundId", "gameId"] as const) {
      await expectConstraintFailure("not-null", async (em) => {
        const walletId = await insertWallet(em);
        await insertWager(em, { walletId, [missingField]: null });
      });
    }
  });

  it("enforces unique idempotency keys", async () => {
    await expectConstraintFailure("wager_transactions_idempotency_key_unique", async (em) => {
      const walletId = await insertWallet(em);
      const idempotencyKey = randomUUID();
      await insertWager(em, { walletId, idempotencyKey });
      await insertWager(em, { walletId, idempotencyKey });
    });
  });

  it("rejects non-positive wager amounts", async () => {
    await expectConstraintFailure("wager_transactions_amount_positive", async (em) => {
      const walletId = await insertWallet(em);
      await insertWager(em, { walletId, amountCents: "0" });
    });
  });

  it("rejects wager kinds outside the domain values", async () => {
    await expectConstraintFailure("wager_transactions_kind_valid", async (em) => {
      const walletId = await insertWallet(em);
      await insertWager(em, { walletId, kind: "UNKNOWN" });
    });
  });

  it("rejects wager statuses outside the domain values", async () => {
    await expectConstraintFailure("wager_transactions_status_valid", async (em) => {
      const walletId = await insertWallet(em);
      await insertWager(em, { walletId, status: "UNKNOWN" });
    });
  });

  it("allows only one processed refund or rollback per reference and kind", async () => {
    await expectConstraintFailure(
      "wager_transactions_processed_reference_kind_unique",
      async (em) => {
        const walletId = await insertWallet(em);
        const referenceId = await insertWager(em, {
          walletId,
          kind: "BET",
          status: "PROCESSED",
          observedBalanceCents: "0",
        });
        await insertWager(em, {
          walletId,
          kind: "REFUND",
          status: "PROCESSED",
          referenceTransactionId: referenceId,
          referenceExternalTransactionId: "provider-reference",
          observedBalanceCents: "0",
        });
        await insertWager(em, {
          walletId,
          kind: "REFUND",
          status: "PROCESSED",
          referenceTransactionId: referenceId,
          referenceExternalTransactionId: "provider-reference",
          observedBalanceCents: "0",
        });
      },
    );
  });

  it("rejects negative observed wager balances", async () => {
    await expectConstraintFailure(
      "wager_transactions_observed_balance_non_negative",
      async (em) => {
        const walletId = await insertWallet(em);
        await insertWager(em, { walletId, observedBalanceCents: "-1" });
      },
    );
  });

  it("requires observed balances for processed and rejected wagers", async () => {
    for (const status of ["PROCESSED", "REJECTED"]) {
      await expectConstraintFailure(
        "wager_transactions_observed_balance_required",
        async (em) => {
          const walletId = await insertWallet(em);
          await insertWager(em, {
            walletId,
            status,
            failureCode: status === "REJECTED" ? "INSUFFICIENT_FUNDS" : null,
          });
        },
      );
    }
  });

  it("requires an external reference for refunds and rollbacks", async () => {
    for (const kind of ["REFUND", "ROLLBACK"]) {
      await expectConstraintFailure(
        "wager_transactions_reference_external_transaction_required",
        async (em) => {
          const walletId = await insertWallet(em);
          await insertWager(em, { walletId, kind });
        },
      );
    }
  });

  it("requires failure codes exactly for rejected or failed wagers", async () => {
    for (const status of ["REJECTED", "FAILED"]) {
      await expectConstraintFailure(
        "wager_transactions_failure_code_matches_status",
        async (em) => {
          const walletId = await insertWallet(em);
          await insertWager(em, { walletId, status });
        },
      );
    }

    await expectConstraintFailure(
      "wager_transactions_failure_code_matches_status",
      async (em) => {
        const walletId = await insertWallet(em);
        await insertWager(em, { walletId, failureCode: "INVALID_WAGER" });
      },
    );
  });

  it("enforces one ledger entry per wallet and transaction", async () => {
    await expectConstraintFailure(
      "wallet_ledger_entries_wallet_transaction_unique",
      async (em) => {
        const walletId = await insertWallet(em);
        const transactionId = await insertWager(em, { walletId });
        await insertLedger(em, { walletId, transactionId });
        await insertLedger(em, { walletId, transactionId });
      },
    );
  });

  it("rejects invalid ledger directions", async () => {
    await expectConstraintFailure("wallet_ledger_entries_balance_arithmetic", async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, { walletId, transactionId, direction: "UNKNOWN" });
    });
  });

  it("rejects non-positive ledger amounts", async () => {
    await expectConstraintFailure("wallet_ledger_entries_amount_positive", async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, { walletId, transactionId, amountCents: "0" });
    });
  });

  it("enforces credit and debit balance arithmetic", async () => {
    await expectConstraintFailure("wallet_ledger_entries_balance_arithmetic", async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, {
        walletId,
        transactionId,
        direction: "CREDIT",
        balanceBeforeCents: "10",
        balanceAfterCents: "12",
      });
    });

    await expectConstraintFailure("wallet_ledger_entries_balance_arithmetic", async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, {
        walletId,
        transactionId,
        direction: "DEBIT",
        balanceBeforeCents: "10",
        balanceAfterCents: "8",
      });
    });
  });

  it("rejects negative ledger balances after an entry", async () => {
    await expectConstraintFailure(
      "wallet_ledger_entries_balance_after_non_negative",
      async (em) => {
        const walletId = await insertWallet(em);
        const transactionId = await insertWager(em, { walletId });
        await insertLedger(em, {
          walletId,
          transactionId,
          direction: "DEBIT",
          amountCents: "2",
          balanceBeforeCents: "1",
          balanceAfterCents: "-1",
        });
      },
    );
  });

  it("blocks ledger updates and deletes", async () => {
    const mutationError = "wallet_ledger_entries is append-only";

    await expectConstraintFailure(mutationError, async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, { walletId, transactionId });
      await execute(
        em,
        "UPDATE wallet_ledger_entries SET amount_cents = '2' WHERE wallet_id = ? AND transaction_id = ?",
        [walletId, transactionId],
      );
    });

    await expectConstraintFailure(mutationError, async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, { walletId, transactionId });
      await execute(
        em,
        "DELETE FROM wallet_ledger_entries WHERE wallet_id = ? AND transaction_id = ?",
        [walletId, transactionId],
      );
    });
  });

  it("blocks truncating the ledger", async () => {
    await expectConstraintFailure("wallet_ledger_entries is append-only", async (em) => {
      const walletId = await insertWallet(em);
      const transactionId = await insertWager(em, { walletId });
      await insertLedger(em, { walletId, transactionId });
      await execute(em, "TRUNCATE wallet_ledger_entries");
    });
  });

  it("enforces inbox uniqueness per consumer and message", async () => {
    await expectConstraintFailure("inbox_messages_pkey", async (em) => {
      const messageId = "provider-message-001";
      await execute(
        em,
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, payload) VALUES (?, ?, ?, '{}'::jsonb)",
        ["test-consumer", messageId, "test-payload-hash"],
      );
      await execute(
        em,
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, payload) VALUES (?, ?, ?, '{}'::jsonb)",
        ["test-consumer", messageId, "test-payload-hash"],
      );
    });
  });

  it("requires an inbox payload hash and accepts text message identifiers", async () => {
    await expectConstraintFailure("not-null", async (em) => {
      await execute(
        em,
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, payload) VALUES (?, ?, ?, '{}'::jsonb)",
        ["test-consumer", "provider-message-no-hash", null],
      );
    });

    await withRollback(async (em) => {
      await execute(
        em,
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, payload) VALUES (?, ?, ?, '{}'::jsonb)",
        ["test-consumer", "provider-message-not-a-uuid", "test-payload-hash"],
      );
      const columns = await execute(
        em,
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'inbox_messages'
           AND column_name IN ('message_id', 'payload_hash')`,
      );

      expect(columns).toContainEqual({ column_name: "message_id", data_type: "text" });
      expect(columns).toContainEqual({ column_name: "payload_hash", data_type: "text" });
    });
  });

  it("creates the partial outbox retry index", async () => {
    const rows = await execute(
      getOrm().em,
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'outbox_messages'
         AND indexname = 'outbox_messages_unpublished_next_attempt_at_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("WHERE (published_at IS NULL)");
  });

  it("creates the pending-reference retry index", async () => {
    const rows = await execute(
      getOrm().em,
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'wager_transactions'
         AND indexname = 'wager_transactions_pending_reference_next_attempt_at_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(reference_next_attempt_at)");
    expect(rows[0]?.indexdef).toContain("WHERE (status = 'PENDING_REFERENCE'::text)");
  });

  it("creates the wallet ledger ordering index", async () => {
    const rows = await execute(
      getOrm().em,
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'wallet_ledger_entries'
         AND indexname = 'wallet_ledger_entries_wallet_id_id_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain("(wallet_id, id)");
  });
});
