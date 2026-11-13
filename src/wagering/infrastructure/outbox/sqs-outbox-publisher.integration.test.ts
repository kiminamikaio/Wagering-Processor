import "../../../test-support/disable-outbox-publisher";
import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  DeleteMessageBatchCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SendMessageCommandOutput,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { EntityManager } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../../shared/infrastructure/database/mikro-orm.config";
import { AppModule } from "../../../app.module";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import { SubmitWagerTransactionInput } from "../../application/submit-wager-transaction.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { BunIdGenerator } from "../runtime/bun-id-generator";
import { SystemClock } from "../runtime/system-clock";
import { executeRows, requiredDate, requiredString } from "../database/sql";
import { executeStatement } from "../database/sql";
import { MikroOrmWageringUnitOfWork } from "../database/wagering-unit-of-work";
import {
  ClaimedOutboxMessage,
  OutboxClock,
  OutboxPublisherOptions,
  SqsOutboxPublisher,
  createOutboxSqsClient,
  outboxPublisherOptionsFromEnvironment,
} from "./sqs-outbox-publisher";

class ManualClock implements OutboxClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class TrackingSqsSender {
  readonly sendAttempts: string[] = [];
  readonly sentBodies: string[] = [];
  fail = false;

  constructor(private readonly client: SQSClient) {}

  async send(command: SendMessageCommand): Promise<SendMessageCommandOutput> {
    const body = command.input.MessageBody ?? "";
    this.sendAttempts.push(body);
    if (this.fail) {
      throw new Error("forced SQS outage");
    }

    const result = await this.client.send(command);
    this.sentBodies.push(body);
    return result;
  }
}

let orm: MikroORM;
let sqs: SQSClient;
let queueUrl: string;
let unitOfWork: MikroOrmWageringUnitOfWork;
let createWalletUseCase: CreateWalletUseCase;
let submitWagerUseCase: SubmitWagerTransactionUseCase;
let preexistingPendingRows: Array<{ id: string; nextAttemptAt: Date }> = [];

function publisher(
  sender: TrackingSqsSender | SQSClient,
  instanceId = Bun.randomUUIDv7(),
  clock = new ManualClock(new Date()),
  overrides: Partial<OutboxPublisherOptions> = {},
): SqsOutboxPublisher {
  return new SqsOutboxPublisher(
    orm.em,
    sender,
    instanceId,
    clock,
    {
      ...outboxPublisherOptionsFromEnvironment(),
      queueUrl,
      enabled: false,
      batchSize: 1_000,
      intervalMs: 100,
      leaseMs: 1_000,
      ...overrides,
    },
  );
}

async function drainQueue(): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let reads = 0; reads < 10_000; reads += 1) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    const received = response.Messages ?? [];
    if (received.length === 0) {
      return messages;
    }

    const deletions = received.flatMap((message, index) =>
      message.ReceiptHandle === undefined
        ? []
        : [{ Id: String(index), ReceiptHandle: message.ReceiptHandle }],
    );
    if (deletions.length > 0) {
      const deleted = await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: deletions,
        }),
      );
      if ((deleted.Failed?.length ?? 0) > 0) {
        throw new Error("MiniStack failed to delete received queue messages.");
      }
    }

    for (const message of received) {
      if (message.Body !== undefined) {
        messages.push(JSON.parse(message.Body) as Record<string, unknown>);
      }
    }
  }

  throw new Error("The SQS queue could not be drained within 10,000 receives.");
}

async function countRows(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = await executeRows(orm.em.fork(), sql, params);
  return Number(requiredString(rows[0]!, "count"));
}

async function enqueueTestEvents(count: number): Promise<string[]> {
  const eventIds = Array.from({ length: count }, () => Bun.randomUUIDv7());
  await unitOfWork.run(async (tx) => {
    for (const [index, eventId] of eventIds.entries()) {
      const occurredAt = "1970-01-01T00:00:00.000Z";
      const aggregateId = Bun.randomUUIDv7();
      await tx.outbox.enqueue({
        aggregateType: "Wallet",
        aggregateId,
        eventType: "TestOutboxEvent",
        payload: {
          eventId,
          eventType: "TestOutboxEvent",
          aggregateId,
          correlationId: Bun.randomUUIDv7(),
          occurredAt,
          version: 1,
          data: {
            index,
            money: { amount: "1.25", currency: "BRL" },
          },
        },
      });
    }
  });
  return eventIds;
}

async function rowForEvent(eventId: string): Promise<Record<string, unknown>> {
  const rows = await executeRows(
    orm.em.fork(),
    `SELECT attempt_count::text AS attempt_count,
            next_attempt_at::text AS next_attempt_at,
            published_at::text AS published_at,
            locked_by, locked_until::text AS locked_until, last_error
     FROM outbox_messages
     WHERE payload->>'eventId' = ?`,
    [eventId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function wagerInput(
  walletId: string,
  playerId: string,
  kind: WagerTransactionKind,
  overrides: Partial<SubmitWagerTransactionInput> = {},
): SubmitWagerTransactionInput {
  const suffix = Bun.randomUUIDv7();
  return {
    providerId: "provider-outbox-test",
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    playerId,
    walletId,
    roundId: `round-${suffix}`,
    gameId: `game-${suffix}`,
    kind,
    money: { amount: "1.00", currency: "BRL" },
    ...overrides,
  };
}

async function createWallet(
  initialBalance: string,
): Promise<{ id: string; playerId: string }> {
  const wallet = await createWalletUseCase.execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount: initialBalance, currency: "BRL" },
  });
  return { id: wallet.id, playerId: wallet.playerId };
}

describe("Transactional outbox publisher with PostgreSQL and MiniStack", () => {
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    preexistingPendingRows = (
      await executeRows(
        orm.em.fork(),
        `SELECT id::text AS id, next_attempt_at
         FROM outbox_messages
         WHERE published_at IS NULL`,
      )
    ).map((row) => ({
      id: requiredString(row, "id"),
      nextAttemptAt: requiredDate(row, "next_attempt_at"),
    }));
    await executeStatement(
    orm.em.fork(),
    `UPDATE outbox_messages
     SET next_attempt_at = ?
     WHERE published_at IS NULL`,
    [new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000)],
    );
    unitOfWork = new MikroOrmWageringUnitOfWork(orm.em);
    const clock = new SystemClock();
    const ids = new BunIdGenerator();
    createWalletUseCase = new CreateWalletUseCase(unitOfWork, clock, ids);
    submitWagerUseCase = new SubmitWagerTransactionUseCase(
      unitOfWork,
      clock,
      ids,
    );

    sqs = createOutboxSqsClient();
    const queue = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "wagering-events.fifo" }),
    );
    if (queue.QueueUrl === undefined) {
      throw new Error("MiniStack did not return the wagering events queue URL.");
    }
    queueUrl = process.env.SQS_EVENTS_QUEUE_URL ?? queue.QueueUrl;
  });

  beforeEach(async () => {
    await drainQueue();
  });

  afterAll(async () => {
    sqs?.destroy();
    for (let index = 0; index < preexistingPendingRows.length; index += 250) {
      const batch = preexistingPendingRows.slice(index, index + 250);
      const values = batch.map(() => "(?, ?)").join(", ");
      await executeStatement(
        orm.em.fork(),
        `UPDATE outbox_messages AS outbox
        SET next_attempt_at = original.next_attempt_at::timestamptz
         FROM (VALUES ${values}) AS original(id, next_attempt_at)
         WHERE outbox.id = original.id::uuid
           AND outbox.published_at IS NULL`,
        batch.flatMap((row) => [row.id, row.nextAttemptAt]),
      );
    }
    await orm?.close(true);
  });

  it("publishes the complete committed BET envelope and marks it published", async () => {
    const wallet = await createWallet("0.00");
    const win = await submitWagerUseCase.execute(
      wagerInput(wallet.id, wallet.playerId, WagerTransactionKind.WIN, {
        money: { amount: "20.00", currency: "BRL" },
      }),
    );
    await publisher(sqs).publishOnce();
    await drainQueue();

    const bet = await submitWagerUseCase.execute(
      wagerInput(wallet.id, wallet.playerId, WagerTransactionKind.BET, {
        money: { amount: "5.00", currency: "BRL" },
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.PROCESSED);
    const result = await publisher(sqs).publishOnce();
    expect(result.published).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);

    const messages = await drainQueue();
    const processed = messages.find(
      (message) =>
        message.eventType === "WagerTransactionProcessed" &&
        isForTransaction(message, bet.transactionId),
    );
    expect(processed).toMatchObject({
      eventId: expect.any(String),
      eventType: "WagerTransactionProcessed",
      aggregateId: wallet.id,
      correlationId: expect.any(String),
      occurredAt: expect.stringMatching(/Z$/),
      version: 1,
      data: {
        transactionId: bet.transactionId,
        money: { amount: "5.00", currency: "BRL" },
        balance: { amount: "15.00", currency: "BRL" },
      },
    });

    const rows = await executeRows(
      orm.em.fork(),
      `SELECT published_at
       FROM outbox_messages
       WHERE payload->'data'->>'transactionId' = ?`,
      [bet.transactionId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.published_at !== null)).toBe(true);
    expect(win.status).toBe(WagerTransactionStatus.PROCESSED);
  });

  it("rolls back an enqueued event with its failed SQL transaction", async () => {
    const eventId = Bun.randomUUIDv7();

    await expect(
      unitOfWork.run(async (tx) => {
        await tx.outbox.enqueue({
          aggregateType: "Wallet",
          aggregateId: Bun.randomUUIDv7(),
          eventType: "WagerTransactionProcessed",
          payload: {
            eventId,
            eventType: "WagerTransactionProcessed",
            aggregateId: Bun.randomUUIDv7(),
            correlationId: Bun.randomUUIDv7(),
            occurredAt: new Date().toISOString(),
            version: 1,
            data: { money: { amount: "1.00", currency: "BRL" } },
          },
        });
        throw new Error("fail after outbox enqueue");
      }),
    ).rejects.toThrow("fail after outbox enqueue");

    expect(
      await countRows(
        "SELECT COUNT(*)::text AS count FROM outbox_messages WHERE payload->>'eventId' = ?",
        [eventId],
      ),
    ).toBe(0);
    expect(
      (await drainQueue()).some((message) => message.eventId === eventId),
    ).toBe(false);
  });

  it("claims and publishes 100 events exactly once across two concurrent publishers", async () => {
    const eventIds = await enqueueTestEvents(100);
    const senderA = new TrackingSqsSender(sqs);
    const senderB = new TrackingSqsSender(sqs);
    const publisherA = publisher(senderA, "publisher-a", undefined, {
      batchSize: 10,
    });
    const publisherB = publisher(senderB, "publisher-b", undefined, {
      batchSize: 10,
    });
    const results = [];
    for (let round = 0; round < 5; round += 1) {
      results.push(
        ...(await Promise.all([
          publisherA.publishOnce(),
          publisherB.publishOnce(),
        ])),
      );
    }

    expect(results.reduce((total, result) => total + result.claimed, 0)).toBe(
      100,
    );
    expect(results.reduce((total, result) => total + result.published, 0)).toBe(
      100,
    );
    expect(results.reduce((total, result) => total + result.failed, 0)).toBe(0);
    const sentEventIds = [...senderA.sentBodies, ...senderB.sentBodies]
      .map((body) => (JSON.parse(body) as Record<string, unknown>).eventId)
      .filter((eventId) => eventIds.includes(String(eventId)));
    expect(sentEventIds).toHaveLength(100);
    expect(new Set(sentEventIds).size).toBe(100);
    expect(new Set(sentEventIds)).toEqual(new Set(eventIds));
    const messages = await drainQueue();
    const ownMessages = messages.filter((message) =>
      eventIds.includes(String(message.eventId)),
    );
    expect(ownMessages).toHaveLength(100);
    expect(new Set(ownMessages.map((message) => message.eventId)).size).toBe(100);
    expect(
      await countRows(
        `SELECT COUNT(*)::text AS count
         FROM outbox_messages
         WHERE payload->>'eventId' IN (${eventIds.map(() => "?").join(",")})
           AND (published_at IS NULL OR locked_by IS NOT NULL)`,
        eventIds,
      ),
    ).toBe(0);
  });

  it("reclaims an un-published claim only after its lease expires", async () => {
    const [eventId] = await enqueueTestEvents(1);
    const clock = new ManualClock(new Date());
    const publisherA = publisher(sqs, "publisher-a", clock, {
      leaseMs: 5_000,
      batchSize: 1,
    });
    const publisherB = publisher(sqs, "publisher-b", clock, {
      leaseMs: 5_000,
      batchSize: 1,
    });

    const claimed = await publisherA.claimBatch();
    expect(claimed).toHaveLength(1);
    expect((await publisherB.publishOnce()).claimed).toBe(0);
    expect(await rowForEvent(eventId!).then((row) => row.locked_by)).toBe(
      "publisher-a",
    );

    clock.advance(5_001);
    expect(await publisherB.publishOnce()).toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    expect(await rowForEvent(eventId!).then((row) => row.published_at))
      .not.toBeNull();
    expect(await drainQueue()).toHaveLength(1);
  });

  it("safely republishes after send-before-mark failure using the same eventId", async () => {
    const [eventId] = await enqueueTestEvents(1);
    const clock = new ManualClock(new Date());
    const sender = new TrackingSqsSender(sqs);
    const publisherA = publisher(sender, "publisher-a", clock, {
      leaseMs: 5_000,
      batchSize: 1,
    });
    const publisherB = publisher(sender, "publisher-b", clock, {
      leaseMs: 5_000,
      batchSize: 1,
    });

    const [claimed] = await publisherA.claimBatch();
    expect(claimed).toBeDefined();
    await publisherA.sendClaimed(claimed as ClaimedOutboxMessage);
    expect((await publisherB.publishOnce()).claimed).toBe(0);

    clock.advance(5_001);
    const result = await publisherB.publishOnce();
    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(sender.sentBodies).toHaveLength(2);
    expect(
      sender.sentBodies.map(
        (body) => (JSON.parse(body) as Record<string, unknown>).eventId,
      ),
    ).toEqual([eventId, eventId]);
    expect(await rowForEvent(eventId!).then((row) => row.published_at))
      .not.toBeNull();
  });

  it("records a transient SQS failure and retries successfully after backoff", async () => {
    const [eventId] = await enqueueTestEvents(1);
    const clock = new ManualClock(new Date());
    const sender = new TrackingSqsSender(sqs);
    sender.fail = true;
    const outboxPublisher = publisher(sender, "publisher-a", clock, {
      batchSize: 1,
    });

    expect(await outboxPublisher.publishOnce()).toMatchObject({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    const failed = await rowForEvent(eventId!);
    expect(failed.attempt_count).toBe("1");
    expect(new Date(requiredString(failed, "next_attempt_at")).getTime())
      .toBeGreaterThan(clock.now().getTime());
    expect(failed.published_at).toBeNull();
    expect(failed.last_error).toBe("Error");
    expect(
      (await drainQueue()).some((message) => message.eventId === eventId),
    ).toBe(false);

    sender.fail = false;
    clock.advance(5 * 60_000);
    expect(await outboxPublisher.publishOnce()).toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
    });
    expect(await rowForEvent(eventId!).then((row) => row.published_at))
      .not.toBeNull();
    expect(await drainQueue()).toHaveLength(1);
  });

  it("publishes LOSS and pending-reference events without a balance-change event", async () => {
    const wallet = await createWallet("0.00");
    const loss = await submitWagerUseCase.execute(
      wagerInput(wallet.id, wallet.playerId, WagerTransactionKind.LOSS),
    );
    const pending = await submitWagerUseCase.execute(
      wagerInput(wallet.id, wallet.playerId, WagerTransactionKind.ROLLBACK, {
        referenceExternalTransactionId: `missing-${Bun.randomUUIDv7()}`,
      }),
    );
    expect(loss.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    const publishedEvents = await publisher(sqs).publishOnce();
    expect(publishedEvents.published).toBeGreaterThanOrEqual(2);
    expect(publishedEvents.failed).toBe(0);
    const messages = await drainQueue();
    const eventTypesByTransaction = messages.map((message) => ({
      eventType: message.eventType,
      transactionId: isRecord(message.data) ? message.data.transactionId : undefined,
    }));
    expect(eventTypesByTransaction).toContainEqual({
      eventType: "WagerTransactionProcessed",
      transactionId: loss.transactionId,
    });
    expect(eventTypesByTransaction).toContainEqual({
      eventType: "WagerTransactionPendingReference",
      transactionId: pending.transactionId,
    });
    expect(eventTypesByTransaction).not.toContainEqual({
      eventType: "WalletBalanceChanged",
      transactionId: loss.transactionId,
    });
  });

  it("publishes an app's pending outbox event after restart in a new app instance", async () => {
    let firstApp: INestApplication | undefined;
    let restartedApp: INestApplication | undefined;
    try {
      firstApp = await NestFactory.create(AppModule, { logger: false });
      const wallet = await firstApp.get(CreateWalletUseCase).execute({
        playerId: Bun.randomUUIDv7(),
        initialBalance: { amount: "0.00", currency: "BRL" },
      });
      const result = await firstApp.get(SubmitWagerTransactionUseCase).execute(
        wagerInput(wallet.id, wallet.playerId, WagerTransactionKind.LOSS),
      );
      await firstApp.close();
      firstApp = undefined;

      restartedApp = await NestFactory.create(AppModule, { logger: false });
      const publishResult = await restartedApp
        .get(SqsOutboxPublisher)
        .publishOnce();
      expect(publishResult.published).toBeGreaterThanOrEqual(1);
      const messages = await drainQueue();
      expect(
        messages.some(
          (message) =>
            message.eventType === "WagerTransactionProcessed" &&
            isForTransaction(message, result.transactionId),
        ),
      ).toBe(true);
    } finally {
      await firstApp?.close();
      await restartedApp?.close();
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForTransaction(
  message: Record<string, unknown>,
  transactionId: string,
): boolean {
  return isRecord(message.data) && message.data.transactionId === transactionId;
}
