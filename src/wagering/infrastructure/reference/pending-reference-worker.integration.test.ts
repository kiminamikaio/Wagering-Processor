import "../../../test-support/disable-outbox-publisher";
import "reflect-metadata";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "bun:test";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "../../../app.module";
import { WAGERING_UNIT_OF_WORK } from "../../../http/tokens";
import {
  Clock,
  IdGenerator,
  WageringUnitOfWork,
} from "../../application/ports/wagering-unit-of-work";
import { SubmitWagerTransactionInput } from "../../application/submit-wager-transaction.use-case";
import { FailureCode } from "../../domain/errors";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { assertWalletMatchesLedger } from "../../../test-support/assert-wallet-matches-ledger";
import {
  executeRows,
  executeStatement,
  requiredDate,
  requiredString,
} from "../database/sql";
import { BunIdGenerator } from "../runtime/bun-id-generator";
import {
  PendingReferenceWorker,
  PendingReferenceWorkerOptions,
} from "./pending-reference-worker";

process.env.PENDING_REFERENCE_WORKER_ENABLED = "false";

interface WalletResponse {
  id: string;
  playerId: string;
}

interface WagerResponse {
  transactionId: string;
  status: string;
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay?: boolean;
}

class MutableClock implements Clock {
  constructor(private milliseconds: number) {}

  now(): Date {
    return new Date(this.milliseconds);
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }

  set(date: Date): void {
    this.milliseconds = date.getTime();
  }
}

let app: INestApplication;
let orm: MikroORM;
let baseUrl: string;
let ids: IdGenerator;
let unitOfWork: WageringUnitOfWork;
let pendingIds: string[] = [];

const defaultWorkerOptions: PendingReferenceWorkerOptions = {
  batchSize: 100,
  intervalMs: 1_000,
  baseDelayMs: 1_000,
  maxAttempts: 8,
  ttlMs: 900_000,
  enabled: false,
};
function suffix(): string {
  return Bun.randomUUIDv7();
}

async function postJson(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined
        ? {}
        : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

async function createWallet(initialAmount = "100.00"): Promise<WalletResponse> {
  const response = await postJson("/wallets", {
    playerId: suffix(),
    initialBalance: { amount: initialAmount, currency: "BRL" },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<WalletResponse>;
}

function wager(
  wallet: WalletResponse,
  overrides: Partial<SubmitWagerTransactionInput> = {},
): SubmitWagerTransactionInput {
  const id = suffix();
  return {
    providerId: "pending-reference-worker-test",
    externalTransactionId: `external-${id}`,
    idempotencyKey: `key-${id}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "worker-round",
    gameId: "worker-game",
    kind: WagerTransactionKind.BET,
    money: { amount: "1.00", currency: "BRL" },
    ...overrides,
  };
}

async function submit(
  input: SubmitWagerTransactionInput,
): Promise<{ status: number; body: WagerResponse }> {
  const { idempotencyKey, ...requestBody } = input;
  const response = await postJson(
    "/wagering/transactions",
    requestBody,
    idempotencyKey,
  );
  const responseBody = (await response.json()) as WagerResponse;
  if (response.status === 202) {
    pendingIds.push(responseBody.transactionId);
  }
  return { status: response.status, body: responseBody };
}

function worker(
  clock: Clock,
  overrides: Partial<PendingReferenceWorkerOptions> = {},
  random: () => number = () => 0.5,
): PendingReferenceWorker {
  return new PendingReferenceWorker(
    unitOfWork,
    clock,
    ids,
    { ...defaultWorkerOptions, ...overrides },
    random,
  );
}

async function count(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = await executeRows(orm.em.fork(), sql, params);
  return Number(requiredString(rows[0]!, "count"));
}

async function events(
  transactionId: string,
): Promise<Array<{ event_type: string; payload: Record<string, unknown> }>> {
  const rows = await executeRows(
    orm.em.fork(),
    `SELECT event_type, payload
     FROM outbox_messages
     WHERE payload->'data'->>'transactionId' = ?
     ORDER BY created_at, id`,
    [transactionId],
  );
  return rows.map((row) => ({
    event_type: requiredString(row, "event_type"),
    payload: row.payload as Record<string, unknown>,
  }));
}

async function setWorkerClockAfter(
  transactionId: string,
  offsetMs = 2_000,
): Promise<MutableClock> {
  const rows = await executeRows(
    orm.em.fork(),
    `SELECT reference_next_attempt_at
     FROM wager_transactions
     WHERE id = ?`,
    [transactionId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("The pending reference does not have a retry schedule.");
  }
  const nextAt = requiredDate(row, "reference_next_attempt_at");
  return new MutableClock(nextAt.getTime() + offsetMs);
}

describe("pending reference worker with PostgreSQL", () => {
  beforeAll(async () => {
    app = await NestFactory.create(AppModule);
    orm = app.get(MikroORM);
    await orm.getMigrator().up();
    await executeStatement(
      orm.em.fork(),
      `UPDATE wager_transactions
       SET reference_next_attempt_at = ?
       WHERE provider_id = 'pending-reference-worker-test'
         AND status = 'PENDING_REFERENCE'`,
      [new Date(Date.now() + 86_400_000)],
    );
    unitOfWork = app.get<WageringUnitOfWork>(WAGERING_UNIT_OF_WORK);
    ids = new BunIdGenerator();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number } | null;
    if (address === null) {
      throw new Error("Nest did not expose an ephemeral HTTP port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    if (pendingIds.length === 0) {
      return;
    }
    for (const id of pendingIds) {
      await executeStatement(
        orm.em.fork(),
        `UPDATE wager_transactions
         SET reference_next_attempt_at = ?
         WHERE id = ? AND status = 'PENDING_REFERENCE'`,
        [new Date(Date.now() + 86_400_000), id],
      );
    }
    pendingIds = [];
  });

  it("resolves a pending ROLLBACK, emits balance events once, and replays over HTTP", async () => {
    const wallet = await createWallet("10.00");
    const referenceExternalTransactionId = `future-bet-${suffix()}`;
    const rollback = wager(wallet, {
      externalTransactionId: `rollback-${suffix()}`,
      kind: WagerTransactionKind.ROLLBACK,
      referenceExternalTransactionId,
      money: { amount: "2.00", currency: "BRL" },
    });

    expect((await submit(rollback)).status).toBe(202);
    const bet = wager(wallet, {
      externalTransactionId: referenceExternalTransactionId,
      kind: WagerTransactionKind.BET,
      roundId: rollback.roundId,
      money: rollback.money,
    });
    expect((await submit(bet)).status).toBe(200);

    const clock = await setWorkerClockAfter(
      (await unitOfWork.run((tx) =>
        tx.transactions.findByIdempotencyKeyOrExternalId(
          rollback.providerId,
          rollback.externalTransactionId,
          rollback.idempotencyKey,
        ),
      ))!.transaction.id,
    );
    const result = await worker(clock).runOnce("pending-reference-worker-test");
    expect(result.resolved).toBe(1);

    const replay = await submit(rollback);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      status: WagerTransactionStatus.PROCESSED,
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: true,
    });
    const processedEvents = await events(
      replay.body.transactionId,
    );
    const eventTypes = processedEvents.map((event) => event.event_type);
    expect(eventTypes.filter((type) => type === "WagerTransactionPendingReference"))
      .toHaveLength(1);
    expect(eventTypes.filter((type) => type === "WagerTransactionProcessed"))
      .toHaveLength(1);
    expect(eventTypes.filter((type) => type === "WalletBalanceChanged"))
      .toHaveLength(1);
    expect(
      await count(
        `SELECT COUNT(*)::text AS count
         FROM wallet_ledger_entries
         WHERE transaction_id = ? AND direction = 'CREDIT'`,
        [replay.body.transactionId],
      ),
    ).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("retries missing references with attempts and rejects once the attempt limit is reached", async () => {
    const wallet = await createWallet();
    const input = wager(wallet, {
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: `never-arrives-${suffix()}`,
    });
    expect((await submit(input)).status).toBe(202);
    const record = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
      ),
    ))!;
    const clock = await setWorkerClockAfter(record.transaction.id);
    const retryWorker = worker(clock, { maxAttempts: 3, ttlMs: 1_800_000 });

    expect(
      (await retryWorker.runOnce("pending-reference-worker-test")).rescheduled,
    ).toBe(1);
    expect(
      (
        await unitOfWork.run((tx) =>
          tx.transactions.findByIdempotencyKeyOrExternalId(
            input.providerId,
            input.externalTransactionId,
            input.idempotencyKey,
          ),
        )
      )!.transaction.referenceAttempts,
    ).toBe(1);
    expect(
      (await retryWorker.runOnce("pending-reference-worker-test")).claimed,
    ).toBe(0);
    clock.advance(10_000);
    expect(
      (await retryWorker.runOnce("pending-reference-worker-test")).rescheduled,
    ).toBe(1);
    expect(
      (
        await unitOfWork.run((tx) =>
          tx.transactions.findByIdempotencyKeyOrExternalId(
            input.providerId,
            input.externalTransactionId,
            input.idempotencyKey,
          ),
        )
      )!.transaction.referenceAttempts,
    ).toBe(2);
    clock.advance(10_000);
    const finalRun = await retryWorker.runOnce("pending-reference-worker-test");
    expect(finalRun.rejected).toBe(1);

    const replay = await submit(input);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: WagerTransactionStatus.REJECTED,
      failureCode: FailureCode.REFERENCE_NOT_FOUND,
      idempotentReplay: true,
    });
    const persisted = await events(record.transaction.id);
    expect(
      persisted.filter(
        (event) => event.event_type === "WagerTransactionPendingReference",
      ),
    ).toHaveLength(1);
    expect(persisted.map((event) => event.event_type)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    expect(
      await count(
        "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ?",
        [record.transaction.id],
      ),
    ).toBe(0);
    const transaction = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
      ),
    ))!.transaction;
    expect(transaction.referenceAttempts).toBe(3);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("rejects a pending reference when its TTL expires before the attempt limit", async () => {
    const wallet = await createWallet();
    const input = wager(wallet, {
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: `expired-${suffix()}`,
    });
    expect((await submit(input)).status).toBe(202);
    const record = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
      ),
    ))!;
    const clock = new MutableClock(
      record.transaction.createdAt.getTime() + 5_001,
    );
    const result = await worker(clock, { ttlMs: 5_000 }).runOnce(
      "pending-reference-worker-test",
    );
    expect(result.rejected).toBe(1);
    expect(
      (await events(record.transaction.id)).map((event) => event.event_type),
    ).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    const replay = await submit(input);
    expect(replay.status).toBe(422);
    expect(replay.body.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("does not touch a reference before its scheduled retry time", async () => {
    const wallet = await createWallet();
    const input = wager(wallet, {
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: `not-due-${suffix()}`,
    });
    expect((await submit(input)).status).toBe(202);
    const record = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
      ),
    ))!;
    const scheduledAt = record.transaction.referenceNextAttemptAt;
    if (scheduledAt === undefined) {
      throw new Error("The pending reference has no scheduled retry.");
    }
    const clock = new MutableClock(scheduledAt.getTime() - 1);
    expect(
      (await worker(clock).runOnce("pending-reference-worker-test")).claimed,
    ).toBe(0);
    const unchanged = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
      ),
    ))!.transaction;
    expect(unchanged.referenceAttempts).toBe(0);
    expect(unchanged.referenceNextAttemptAt).toEqual(scheduledAt);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("rejects deferred reversals for amount and round mismatches", async () => {
    const wallet = await createWallet();
    const amountReference = `amount-reference-${suffix()}`;
    const amountRefund = wager(wallet, {
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: amountReference,
      money: { amount: "3.00", currency: "BRL" },
    });
    const roundReference = `round-reference-${suffix()}`;
    const roundRefund = wager(wallet, {
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId: roundReference,
      roundId: "different-round",
      money: { amount: "2.00", currency: "BRL" },
    });
    expect((await submit(amountRefund)).status).toBe(202);
    expect((await submit(roundRefund)).status).toBe(202);
    expect(
      (
        await submit(
          wager(wallet, {
            externalTransactionId: amountReference,
            roundId: amountRefund.roundId,
            money: { amount: "2.00", currency: "BRL" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await submit(
          wager(wallet, {
            externalTransactionId: roundReference,
            roundId: "actual-round",
            money: roundRefund.money,
          }),
        )
      ).status,
    ).toBe(200);

    const clock = await setWorkerClockAfter(
      (await unitOfWork.run((tx) =>
        tx.transactions.findByIdempotencyKeyOrExternalId(
          amountRefund.providerId,
          amountRefund.externalTransactionId,
          amountRefund.idempotencyKey,
        ),
      ))!.transaction.id,
    );
    expect(
      (await worker(clock).runOnce("pending-reference-worker-test")).rejected,
    ).toBe(2);
    for (const input of [amountRefund, roundRefund]) {
      const replay = await submit(input);
      expect(replay.status).toBe(422);
      expect(replay.body.failureCode).toBe(
        input === amountRefund
          ? FailureCode.AMOUNT_MISMATCH
          : FailureCode.REFERENCE_MISMATCH,
      );
    }
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("rejects a pending WIN rollback when its debit would overdraw the wallet", async () => {
    const wallet = await createWallet("0.00");
    const winExternalId = `future-win-${suffix()}`;
    const rollback = wager(wallet, {
      kind: WagerTransactionKind.ROLLBACK,
      referenceExternalTransactionId: winExternalId,
      money: { amount: "5.00", currency: "BRL" },
    });
    expect((await submit(rollback)).status).toBe(202);
    expect(
      (
        await submit(
          wager(wallet, {
            externalTransactionId: winExternalId,
            kind: WagerTransactionKind.WIN,
            roundId: rollback.roundId,
            money: rollback.money,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await submit(
          wager(wallet, {
            kind: WagerTransactionKind.BET,
            money: { amount: "5.00", currency: "BRL" },
          }),
        )
      ).status,
    ).toBe(200);

    const pending = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        rollback.providerId,
        rollback.externalTransactionId,
        rollback.idempotencyKey,
      ),
    ))!;
    expect(
      (
        await worker(await setWorkerClockAfter(pending.transaction.id)).runOnce(
          "pending-reference-worker-test",
        )
      ).rejected,
    ).toBe(1);
    const replay = await submit(rollback);
    expect(replay.body.failureCode).toBe(FailureCode.REVERSAL_WOULD_OVERDRAW);
    expect(
      await count(
        "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ?",
        [pending.transaction.id],
      ),
    ).toBe(0);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("allows only one of two pending refunds to reverse the same BET", async () => {
    const wallet = await createWallet();
    const betExternalId = `future-bet-${suffix()}`;
    const refunds = [0, 1].map(() =>
      wager(wallet, {
        kind: WagerTransactionKind.REFUND,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    for (const refund of refunds) {
      expect((await submit(refund)).status).toBe(202);
    }
    expect(
      (
        await submit(
          wager(wallet, {
            externalTransactionId: betExternalId,
            money: refunds[0]!.money,
          }),
        )
      ).status,
    ).toBe(200);

    const first = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        refunds[0]!.providerId,
        refunds[0]!.externalTransactionId,
        refunds[0]!.idempotencyKey,
      ),
    ))!;
    expect(
      (
        await worker(
          await setWorkerClockAfter(first.transaction.id),
        ).runOnce("pending-reference-worker-test")
      )
        .resolved,
    ).toBe(1);
    const states = await Promise.all(refunds.map((refund) => submit(refund)));
    expect(states.map((state) => state.body.status).sort()).toEqual([
      WagerTransactionStatus.PROCESSED,
      WagerTransactionStatus.REJECTED,
    ]);
    expect(
      states.filter(
        (state) => state.body.failureCode === FailureCode.ALREADY_REVERSED,
      ),
    ).toHaveLength(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("safely resolves twenty pending reversals across two concurrent workers", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () => createWallet()),
    );
    const pending: SubmitWagerTransactionInput[] = [];
    const bets: SubmitWagerTransactionInput[] = [];
    for (const wallet of wallets) {
      for (let index = 0; index < 4; index += 1) {
        const referenceId = `batch-bet-${suffix()}`;
        pending.push(
          wager(wallet, {
            kind: WagerTransactionKind.REFUND,
            referenceExternalTransactionId: referenceId,
          }),
        );
        bets.push(
          wager(wallet, {
            externalTransactionId: referenceId,
          }),
        );
      }
    }
    for (const input of pending) {
      expect((await submit(input)).status).toBe(202);
    }
    for (const input of bets) {
      expect((await submit(input)).status).toBe(200);
    }
    const row = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        pending[0]!.providerId,
        pending[0]!.externalTransactionId,
        pending[0]!.idempotencyKey,
      ),
    ))!;
    const clock = await setWorkerClockAfter(row.transaction.id);
    const results = await Promise.all([
      worker(clock).runOnce("pending-reference-worker-test"),
      worker(clock).runOnce("pending-reference-worker-test"),
    ]);
    expect(results.reduce((total, result) => total + result.resolved, 0)).toBe(20);
    const replayed = await Promise.all(pending.map((input) => submit(input)));
    expect(replayed.every((response) => response.body.status === "PROCESSED")).toBe(
      true,
    );
    for (const replay of replayed) {
      expect(
        await count(
          "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ?",
          [replay.body.transactionId],
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT COUNT(*)::text AS count FROM outbox_messages
           WHERE event_type = 'WagerTransactionProcessed'
             AND payload->'data'->>'transactionId' = ?`,
          [replay.body.transactionId],
        ),
      ).toBe(1);
    }
    for (const wallet of wallets) {
      await assertWalletMatchesLedger(orm.em, wallet.id);
    }
  });

  it("does not deadlock while resolving references alongside twenty HTTP BETs", async () => {
    const wallet = await createWallet("100.00");
    const references = Array.from({ length: 20 }, () => `concurrent-bet-${suffix()}`);
    const pending = references.map((referenceExternalTransactionId) =>
      wager(wallet, {
        kind: WagerTransactionKind.ROLLBACK,
        referenceExternalTransactionId,
      }),
    );
    for (const input of pending) {
      expect((await submit(input)).status).toBe(202);
    }
    const first = (await unitOfWork.run((tx) =>
      tx.transactions.findByIdempotencyKeyOrExternalId(
        pending[0]!.providerId,
        pending[0]!.externalTransactionId,
        pending[0]!.idempotencyKey,
      ),
    ))!;
    const clock = await setWorkerClockAfter(first.transaction.id);
    const bets = references.map((externalTransactionId) =>
      submit(
        wager(wallet, {
          externalTransactionId,
          money: { amount: "1.00", currency: "BRL" },
        }),
      ),
    );
    const [workerRun, betResults] = await Promise.all([
      worker(clock).runOnce("pending-reference-worker-test"),
      Promise.all(bets),
    ]);
    expect(betResults.every((result) => result.status === 200)).toBe(true);
    expect(workerRun.claimed).toBeGreaterThanOrEqual(20);
    clock.advance(10_000);
    const secondRun = await worker(clock).runOnce(
      "pending-reference-worker-test",
    );
    expect(workerRun.resolved + secondRun.resolved).toBe(20);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });
});
