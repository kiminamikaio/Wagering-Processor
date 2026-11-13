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
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../../shared/infrastructure/database/mikro-orm.config";
import { assertWalletMatchesLedger } from "../../../test-support/assert-wallet-matches-ledger";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import { SubmitWagerTransactionInput } from "../../application/submit-wager-transaction.use-case";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { Clock, WageringUnitOfWork } from "../../application/ports/wagering-unit-of-work";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { executeRows, requiredString } from "../database/sql";
import { MikroOrmWageringUnitOfWork } from "../database/wagering-unit-of-work";
import {
  createOutboxSqsClient,
} from "../outbox/sqs-outbox-publisher";
import { BunIdGenerator } from "../runtime/bun-id-generator";
import { SystemClock } from "../runtime/system-clock";
import {
  SqsTransactionConsumer,
  SqsTransactionConsumerOptions,
  SubmitWagerExecutor,
  sqsTransactionConsumerOptionsFromEnvironment,
} from "./sqs-transaction-consumer";
import { PendingReferenceWorker } from "../reference/pending-reference-worker";

process.env.SQS_CONSUMER_ENABLED = "false";

interface WalletFixture {
  id: string;
  playerId: string;
}

interface TestEnvelope {
  messageId: string;
  correlationId?: string;
  type: "WagerTransactionRequested";
  occurredAt: string;
  data: SubmitWagerTransactionInput;
}

let orm: MikroORM;
let sqs: SQSClient;
let queueUrl: string;
let dlqUrl: string;
let unitOfWork: MikroOrmWageringUnitOfWork;
let createWalletUseCase: CreateWalletUseCase;
let submitWagerUseCase: SubmitWagerTransactionUseCase;
let clock: MutableClock;
const consumerName = "sqs-transaction-consumer-integration";

class MutableClock implements Clock {
  private current: Date;

  constructor(now: Date) {
    this.current = now;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(now: Date): void {
    this.current = new Date(now.getTime());
  }
}

function consumer(
  submitWager: SubmitWagerExecutor = submitWagerUseCase,
  overrides: Partial<SqsTransactionConsumerOptions> = {},
  afterCommit?: () => Promise<void>,
): SqsTransactionConsumer {
  return new SqsTransactionConsumer(
    submitWager,
    sqs,
    {
      ...sqsTransactionConsumerOptionsFromEnvironment(),
      queueUrl,
      dlqUrl,
      consumerName,
      waitTimeSeconds: 0,
      maxNumberOfMessages: 10,
      visibilityTimeoutSeconds: 1,
      maxReceives: 5,
      retryMaxDelaySeconds: 1,
      pollIntervalMs: 10,
      enabled: false,
      ...overrides,
    },
    false,
    afterCommit,
  );
}

async function drainQueue(url: string): Promise<number> {
  let removed = 0;
  for (let reads = 0; reads < 100; reads += 1) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      return removed;
    }
    const entries = messages.flatMap((message, index) =>
      message.ReceiptHandle === undefined
        ? []
        : [{ Id: String(index), ReceiptHandle: message.ReceiptHandle }],
    );
    if (entries.length > 0) {
      const result = await sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl: url, Entries: entries }),
      );
      if ((result.Failed?.length ?? 0) > 0) {
        throw new Error(`Could not clean test queue ${url}.`);
      }
      removed += entries.length;
    }
  }
  throw new Error(`Test queue ${url} did not drain.`);
}

async function createWallet(balance = "100.00"): Promise<WalletFixture> {
  const result = await createWalletUseCase.execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount: balance, currency: "BRL" },
  });
  return { id: result.id, playerId: result.playerId };
}

function wagerInput(
  wallet: WalletFixture,
  overrides: Partial<SubmitWagerTransactionInput> = {},
): SubmitWagerTransactionInput {
  const suffix = Bun.randomUUIDv7();
  return {
    providerId: "provider-sqs-test",
    externalTransactionId: `sqs-${suffix}`,
    idempotencyKey: `sqs-key-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "sqs-round",
    gameId: "sqs-game",
    kind: WagerTransactionKind.BET,
    money: { amount: "1.00", currency: "BRL" },
    ...overrides,
  };
}

function envelope(
  data: SubmitWagerTransactionInput,
  messageId = Bun.randomUUIDv7(),
): TestEnvelope {
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}

async function send(
  body: string,
  groupId = Bun.randomUUIDv7(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

async function sendEnvelope(
  message: TestEnvelope,
  groupId = message.data.walletId,
): Promise<void> {
  await send(JSON.stringify(message), groupId);
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await executeRows(orm.em.fork(), sql, params);
  return Number(requiredString(rows[0]!, "count"));
}

async function inboxRow(messageId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await executeRows(
    orm.em.fork(),
    `SELECT payload_hash, processed_at::text AS processed_at
     FROM inbox_messages
     WHERE consumer_name = ? AND message_id = ?`,
    [consumerName, messageId],
  );
  return rows[0];
}

async function readDlq(): Promise<Message[]> {
  const response = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      MessageAttributeNames: ["All"],
    }),
  );
  const messages = response.Messages ?? [];
  const entries = messages.flatMap((message, index) =>
    message.ReceiptHandle === undefined
      ? []
      : [{ Id: String(index), ReceiptHandle: message.ReceiptHandle }],
  );
  if (entries.length > 0) {
    await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: dlqUrl, Entries: entries }));
  }
  return messages;
}

describe("SQS transaction consumer with PostgreSQL and MiniStack", () => {
  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    await orm.getMigrator().up();
    unitOfWork = new MikroOrmWageringUnitOfWork(orm.em);
    clock = new MutableClock(new SystemClock().now());
    const ids = new BunIdGenerator();
    createWalletUseCase = new CreateWalletUseCase(unitOfWork, clock, ids);
    submitWagerUseCase = new SubmitWagerTransactionUseCase(unitOfWork, clock, ids);
    sqs = createOutboxSqsClient();
    const mainQueue = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }),
    );
    const deadLetterQueue = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "wager-transactions-dlq.fifo" }),
    );
    if (mainQueue.QueueUrl === undefined || deadLetterQueue.QueueUrl === undefined) {
      throw new Error("MiniStack did not return both transaction queue URLs.");
    }
    queueUrl = process.env.SQS_QUEUE_URL ?? mainQueue.QueueUrl;
    dlqUrl = process.env.SQS_DLQ_URL ?? deadLetterQueue.QueueUrl;
  });

  beforeEach(async () => {
    clock.set(new Date());
    await drainQueue(queueUrl);
    await drainQueue(dlqUrl);
  });

  afterAll(async () => {
    sqs?.destroy();
    await orm?.close(true);
  });

  it("commits a BET, inbox, ledger and outbox before acknowledging", async () => {
    const wallet = await createWallet();
    const message = {
      ...envelope(wagerInput(wallet)),
      correlationId: `correlation-${Bun.randomUUIDv7()}`,
    };
    await sendEnvelope(message);

    await consumer().pollOnce();

    expect(await drainQueue(queueUrl)).toBe(0);
    const inbox = await inboxRow(message.messageId);
    expect(inbox?.processed_at).toBeString();
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    const transactions = await executeRows(
      orm.em.fork(),
      "SELECT id::text AS id FROM wager_transactions WHERE external_transaction_id = ?",
      [message.data.externalTransactionId],
    );
    expect(transactions).toHaveLength(1);
    expect(await countRows(
      `SELECT COUNT(*)::text AS count FROM outbox_messages
       WHERE aggregate_id = ?
         AND payload->'data'->>'transactionId' = ?
         AND payload->>'correlationId' = ?`,
      [wallet.id, requiredString(transactions[0]!, "id"), message.correlationId],
    )).toBe(2);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("deduplicates the same envelope messageId independent of SQS deduplication IDs", async () => {
    const wallet = await createWallet();
    const message = envelope(wagerInput(wallet));
    await sendEnvelope(message);
    await sendEnvelope(message);

    const result = await consumer().pollOnce();
    expect(result.duplicates).toBe(1);
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    expect(await drainQueue(queueUrl)).toBe(0);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("deduplicates a wager already submitted over HTTP", async () => {
    const wallet = await createWallet();
    const input = wagerInput(wallet);
    await submitWagerUseCase.execute(input);
    const message = envelope(input);
    await sendEnvelope(message);

    const result = await consumer().pollOnce();

    expect(result.duplicates).toBe(0);
    expect(await inboxRow(message.messageId)).toBeDefined();
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("recognizes the inbox after a simulated crash between commit and ack", async () => {
    const wallet = await createWallet();
    const message = envelope(wagerInput(wallet));
    await sendEnvelope(message);
    const first = consumer(
      submitWagerUseCase,
      {},
      async () => {
        throw new Error("simulated worker crash");
      },
    );

    await expect(first.pollOnce()).rejects.toThrow("simulated worker crash");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = consumer();
    const result = await second.pollOnce();

    expect(result.duplicates).toBe(1);
    expect(await drainQueue(queueUrl)).toBe(0);
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("acks a committed insufficient-balance rejection without using the DLQ", async () => {
    const wallet = await createWallet("0.00");
    const message = envelope(wagerInput(wallet));
    await sendEnvelope(message);

    await consumer().pollOnce();

    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE wallet_id = ? AND status = 'REJECTED' AND failure_code = 'INSUFFICIENT_FUNDS'",
      [wallet.id],
    )).toBe(1);
    expect(await inboxRow(message.messageId)).toBeDefined();
    expect(await readDlq()).toHaveLength(0);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("routes malformed JSON and a numeric amount to the DLQ without database writes", async () => {
    const wallet = await createWallet();
    await send("{not-json", wallet.id);
    const invalidEnvelope = envelope(wagerInput(wallet));
    const invalidEnvelopeBody = JSON.parse(JSON.stringify(invalidEnvelope)) as {
      messageId: string;
      data: Record<string, unknown>;
    };
    invalidEnvelopeBody.data.money = { amount: 1, currency: "BRL" };
    await send(JSON.stringify(invalidEnvelopeBody), wallet.id);

    await consumer().pollOnce();

    const messages = await readDlq();
    expect(messages).toHaveLength(2);
    const codes = messages
      .map((message) => message.MessageAttributes?.errorCode?.StringValue)
      .sort();
    expect(codes).toEqual(["INVALID_JSON", "INVALID_SCHEMA"]);
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE external_transaction_id = ?",
      [invalidEnvelope.data.externalTransactionId],
    )).toBe(0);
    expect(await inboxRow(invalidEnvelope.messageId)).toBeUndefined();
    expect(
      messages.every(
        (message) =>
          message.MessageAttributes?.consumerName?.StringValue === consumerName,
      ),
    ).toBe(true);
  });

  it("sends a reused messageId with a different payload to the DLQ", async () => {
    const wallet = await createWallet();
    const first = envelope(wagerInput(wallet));
    await sendEnvelope(first);
    await consumer().pollOnce();

    const conflict = {
      ...first,
      data: { ...first.data, roundId: "different-round" },
    };
    await sendEnvelope(conflict);
    await consumer().pollOnce();

    const messages = await readDlq();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.MessageAttributes?.errorCode?.StringValue).toBe(
      "INBOX_MESSAGE_CONFLICT",
    );
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("sends an idempotency-key payload conflict to the DLQ", async () => {
    const wallet = await createWallet();
    const firstInput = wagerInput(wallet);
    await sendEnvelope(envelope(firstInput));
    await consumer().pollOnce();

    const conflictingInput = {
      ...firstInput,
      money: { amount: "2.00", currency: "BRL" },
    };
    await sendEnvelope(envelope(conflictingInput));
    await consumer().pollOnce();

    const messages = await readDlq();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.MessageAttributes?.errorCode?.StringValue).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("retries a transient failure and later commits only once", async () => {
    const wallet = await createWallet();
    const message = envelope(wagerInput(wallet));
    await sendEnvelope(message);
    let attempts = 0;
    const transientOnce: SubmitWagerExecutor = {
      execute: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("forced temporary database outage");
        }
        return submitWagerUseCase.execute(input);
      },
    };
    const worker = consumer(transientOnce);

    await worker.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await worker.pollOnce();

    expect(attempts).toBe(2);
    expect(await inboxRow(message.messageId)).toBeDefined();
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("moves a permanently transient failure to the DLQ at MAX_RECEIVES", async () => {
    const wallet = await createWallet();
    const input = wagerInput(wallet);
    const message = envelope(input);
    await sendEnvelope(message);
    const failBeforeCommit: WageringUnitOfWork = {
      run: (work) =>
        unitOfWork.run((tx) =>
          work({
            wallets: tx.wallets,
            transactions: tx.transactions,
            ledger: tx.ledger,
            outbox: tx.outbox,
            inbox: {
              insertIfAbsent: (inboxMessage) =>
                tx.inbox.insertIfAbsent(inboxMessage),
              markProcessed: async (consumer, messageId) => {
                await tx.inbox.markProcessed(consumer, messageId);
                throw new Error("forced failure before commit");
              },
            },
          }),
        ),
    };
    const failingUseCase = new SubmitWagerTransactionUseCase(
      failBeforeCommit,
      new SystemClock(),
      new BunIdGenerator(),
    );
    const worker = consumer(failingUseCase, { maxReceives: 2 });

    await worker.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await worker.pollOnce();

    const messages = await readDlq();
    expect(messages).toHaveLength(1);
    const attributes = messages[0]!.MessageAttributes as Record<
      string,
      { StringValue?: string }
    >;
    expect(attributes.errorCode?.StringValue).toBe("MAX_RECEIVES");
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE external_transaction_id = ?",
      [input.externalTransactionId],
    )).toBe(0);
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(0);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("processes messages from concurrent consumers once and preserves wallet order", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () => createWallet("100.00")),
    );
    const orderedIds = new Map<string, string[]>();
    for (let sequence = 0; sequence < 10; sequence += 1) {
      for (const wallet of wallets) {
        const input = wagerInput(wallet, {
          externalTransactionId: `ordered-${wallet.id}-${sequence}`,
          idempotencyKey: `ordered-key-${wallet.id}-${sequence}`,
          money: { amount: `${String(sequence + 1).padStart(2, "0")}.00`, currency: "BRL" },
        });
        const ids = orderedIds.get(wallet.id) ?? [];
        ids.push(input.externalTransactionId);
        orderedIds.set(wallet.id, ids);
        await sendEnvelope(envelope(input));
      }
    }

    const workers = [consumer(), consumer()];
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(workers.map((worker) => worker.pollOnce()));
    }

    for (const wallet of wallets) {
      const rows = await executeRows(
        orm.em.fork(),
        `SELECT wager_transactions.external_transaction_id
         FROM wallet_ledger_entries
         JOIN wager_transactions
           ON wager_transactions.id = wallet_ledger_entries.transaction_id
         WHERE wallet_ledger_entries.wallet_id = ?
           AND wager_transactions.kind <> 'OPENING'
         ORDER BY wallet_ledger_entries.seq`,
        [wallet.id],
      );
      const expectedOrder = orderedIds.get(wallet.id);
      if (expectedOrder === undefined) {
        throw new Error(`Missing expected ordering for wallet ${wallet.id}.`);
      }
      expect(rows.map((row) => row.external_transaction_id)).toEqual(expectedOrder);
      expect(await countRows(
        "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [wallet.id],
      )).toBe(10);
      await assertWalletMatchesLedger(orm.em, wallet.id);
    }
  });

  it("releases unstarted messages during shutdown and lets a new worker process them", async () => {
    const wallet = await createWallet();
    const batch = Array.from({ length: 3 }, () => envelope(wagerInput(wallet)));
    for (const message of batch) {
      await sendEnvelope(message);
    }

    let enteredCommitHook!: () => void;
    const inCommitHook = new Promise<void>((resolve) => {
      enteredCommitHook = resolve;
    });
    let finishCommitHook!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finishCommitHook = resolve;
    });
    const worker = consumer(submitWagerUseCase, { enabled: true }, async () => {
      enteredCommitHook();
      await commitGate;
    });
    worker.onModuleInit();
    await inCommitHook;
    const shutdown = worker.onApplicationShutdown();
    finishCommitHook();
    await shutdown;

    const replacement = consumer();
    await replacement.pollOnce();
    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
      [wallet.id],
    )).toBe(3);
    for (const message of batch) {
      expect(await inboxRow(message.messageId)).toBeDefined();
    }
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("commits and acknowledges a ROLLBACK received before its reference", async () => {
    const wallet = await createWallet();
    const input = wagerInput(wallet, {
      kind: WagerTransactionKind.ROLLBACK,
      referenceExternalTransactionId: "missing-reference",
    });
    const message = envelope(input);
    await sendEnvelope(message);

    await consumer().pollOnce();

    expect(await countRows(
      "SELECT COUNT(*)::text AS count FROM wager_transactions WHERE external_transaction_id = ? AND status = 'PENDING_REFERENCE'",
      [input.externalTransactionId],
    )).toBe(1);
    expect(await inboxRow(message.messageId)).toBeDefined();
    expect(await readDlq()).toHaveLength(0);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });

  it("resolves a pending REFUND after its BET arrives through SQS", async () => {
    const wallet = await createWallet();
    const referenceExternalTransactionId = `sqs-reference-${Bun.randomUUIDv7()}`;
    const refund = wagerInput(wallet, {
      kind: WagerTransactionKind.REFUND,
      referenceExternalTransactionId,
    });
    const pending = await submitWagerUseCase.execute(refund);
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    clock.advance(1_000);
    const bet = wagerInput(wallet, {
      externalTransactionId: referenceExternalTransactionId,
      kind: WagerTransactionKind.BET,
      roundId: refund.roundId,
      money: refund.money,
    });
    const message = envelope(bet);
    await sendEnvelope(message);
    await consumer().pollOnce();
    expect(await inboxRow(message.messageId)).toBeDefined();

    const worker = new PendingReferenceWorker(
      unitOfWork,
      clock,
      new BunIdGenerator(),
      {
        batchSize: 100,
        intervalMs: 1_000,
        baseDelayMs: 1_000,
        maxAttempts: 8,
        ttlMs: 900_000,
        enabled: false,
      },
    );
    expect((await worker.runOnce("provider-sqs-test")).resolved).toBe(1);
    expect(
      await countRows(
        `SELECT COUNT(*)::text AS count
         FROM wallet_ledger_entries
         WHERE transaction_id = ? AND direction = 'CREDIT'`,
        [pending.transactionId],
      ),
    ).toBe(1);
    await assertWalletMatchesLedger(orm.em, wallet.id);
  });
});
