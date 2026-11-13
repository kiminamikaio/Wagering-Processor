import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { EntityManager } from "@mikro-orm/core";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { executeRows, executeStatement, requiredInteger, requiredString } from "../database/sql";
import { runWithLogContext } from "../../../observability/correlation-context";
import { jsonLogger } from "../../../observability/json-logger";
import { metricsRegistry } from "../../../observability/metrics-registry";

export interface OutboxClock {
  now(): Date;
}

export interface OutboxPublisherOptions {
  queueUrl: string;
  batchSize: number;
  intervalMs: number;
  leaseMs: number;
  enabled: boolean;
}

interface OutboxSender {
  send(command: SendMessageCommand): ReturnType<SQSClient["send"]>;
  destroy?(): void;
}

export interface ClaimedOutboxMessage {
  id: string;
  aggregateId: string;
  payload: Readonly<Record<string, unknown>>;
  attemptCount: number;
}

export interface PublishOnceResult {
  claimed: number;
  published: number;
  failed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventIdOf(payload: Readonly<Record<string, unknown>>): string {
  const eventId = payload.eventId;
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new TypeError("The outbox payload must contain an eventId.");
  }
  return eventId;
}

function errorSummary(error: unknown): string {
  if (isRecord(error)) {
    const name = typeof error.name === "string" ? error.name : "Error";
    const code =
      typeof error.code === "string"
        ? error.code
        : typeof error.Code === "string"
          ? error.Code
          : undefined;
    return `${name}${code === undefined ? "" : ` (${code})`}`.slice(0, 200);
  }
  return "UnknownError";
}

function retryDelayMs(attemptCount: number): number {
  const exponential = Math.min(300_000, 1_000 * 2 ** Math.min(attemptCount, 20));
  return Math.min(300_000, Math.max(1, Math.floor(exponential * (0.5 + Math.random()))));
}

export class SqsOutboxPublisher
  implements OnModuleInit, OnApplicationShutdown
{
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeTimer: (() => void) | undefined;

  constructor(
    private readonly em: EntityManager,
    private readonly sender: OutboxSender,
    private readonly instanceId: string,
    private readonly clock: OutboxClock,
    private readonly options: OutboxPublisherOptions,
    private readonly ownsSender = false,
  ) {}

  onModuleInit(): void {
    if (!this.options.enabled) {
      return;
    }

    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.wakeTimer?.();
    }
    await this.loopPromise;
    if (this.ownsSender) {
      this.sender.destroy?.();
    }
  }

  async publishOnce(): Promise<PublishOnceResult> {
    const messages = await this.claimBatch();
    let published = 0;
    let failed = 0;

    for (const message of messages) {
      try {
        await this.sendClaimed(message);
        await this.markPublished(message.id);
        published += 1;
      } catch (error) {
        await this.scheduleRetry(message, error);
        failed += 1;
        metricsRegistry.increment("retries_total", { component: "outbox" });
        jsonLogger.event(
          "error",
          `Outbox publish failed: ${errorSummary(error)}`,
          this.messageLogContext(message),
          "SqsOutboxPublisher",
        );
      }
    }

    return { claimed: messages.length, published, failed };
  }

  async claimBatch(): Promise<ClaimedOutboxMessage[]> {
    const now = this.clock.now();
    const lockedUntil = new Date(now.getTime() + this.options.leaseMs);
    return this.em.fork().transactional(async (em) => {
      const rows = await executeRows(
        em,
        `SELECT id::text AS id, aggregate_id::text AS aggregate_id,
                payload, attempt_count,
                (payload->>'occurredAt')::timestamptz AS occurred_at
         FROM outbox_messages
         WHERE published_at IS NULL
           AND next_attempt_at <= ?
           AND (locked_until IS NULL OR locked_until < ?)
         ORDER BY occurred_at, id
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [now, now, this.options.batchSize],
      );
      const messages: ClaimedOutboxMessage[] = rows.map((row) => {
        const payload = row.payload;
        if (!isRecord(payload)) {
          throw new TypeError("The outbox payload must be a JSON object.");
        }
        return {
          id: requiredString(row, "id"),
          aggregateId: requiredString(row, "aggregate_id"),
          payload,
          attemptCount: requiredInteger(row, "attempt_count"),
        };
      });

      for (const message of messages) {
        await executeStatement(
          em,
          `UPDATE outbox_messages
           SET locked_by = ?, locked_until = ?
           WHERE id = ? AND published_at IS NULL`,
          [this.instanceId, lockedUntil, message.id],
        );
      }

      return messages;
    });
  }

  async sendClaimed(message: ClaimedOutboxMessage): Promise<void> {
    await runWithLogContext(
      this.messageLogContext(message),
      () =>
        this.sender.send(
          new SendMessageCommand({
            QueueUrl: this.options.queueUrl,
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: eventIdOf(message.payload),
            MessageBody: JSON.stringify(message.payload),
          }),
        ),
    );
  }

  private messageLogContext(message: ClaimedOutboxMessage) {
    const data = message.payload.data;
    const providerId =
      typeof data === "object" &&
      data !== null &&
      "providerId" in data &&
      typeof data.providerId === "string"
        ? data.providerId
        : undefined;
    const transactionId =
      typeof data === "object" &&
      data !== null &&
      "transactionId" in data &&
      typeof data.transactionId === "string"
        ? data.transactionId
        : undefined;
    return {
      ...(typeof message.payload.correlationId === "string"
        ? { correlationId: message.payload.correlationId }
        : {}),
      messageId: eventIdOf(message.payload),
      ...(transactionId === undefined ? {} : { transactionId }),
      walletId: message.aggregateId,
      ...(providerId === undefined ? {} : { providerId }),
    };
  }

  private async markPublished(id: string): Promise<void> {
    await this.em.fork().transactional((em) =>
      executeStatement(
        em,
        `UPDATE outbox_messages
         SET published_at = ?, locked_by = NULL, locked_until = NULL,
             last_error = NULL
         WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
        [this.clock.now(), id, this.instanceId],
      ),
    );
  }

  private async scheduleRetry(
    message: ClaimedOutboxMessage,
    error: unknown,
  ): Promise<void> {
    const now = this.clock.now();
    const nextAttemptAt = new Date(
      now.getTime() + retryDelayMs(message.attemptCount),
    );
    await this.em.fork().transactional((em) =>
      executeStatement(
        em,
        `UPDATE outbox_messages
         SET attempt_count = attempt_count + 1,
             next_attempt_at = ?, last_error = ?,
             locked_by = NULL, locked_until = NULL
         WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
        [nextAttemptAt, errorSummary(error), message.id, this.instanceId],
      ),
    );
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.publishOnce();
      } catch (error) {
        jsonLogger.event(
          "error",
          `Outbox publisher loop failed: ${errorSummary(error)}`,
          {},
          "SqsOutboxPublisher",
        );
      }

      if (!this.stopping) {
        await new Promise<void>((resolve) => {
          this.wakeTimer = resolve;
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.wakeTimer = undefined;
            resolve();
          }, this.options.intervalMs);
        });
      }
    }
  }
}

export function outboxPublisherOptionsFromEnvironment(): OutboxPublisherOptions {
  function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return parsed;
  }

  const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  return {
    queueUrl:
      process.env.SQS_EVENTS_QUEUE_URL ??
      `${endpoint.replace(/\/$/, "")}/000000000000/wagering-events.fifo`,
    batchSize: positiveInteger("OUTBOX_PUBLISHER_BATCH_SIZE", 100),
    intervalMs: positiveInteger("OUTBOX_PUBLISHER_INTERVAL_MS", 1_000),
    leaseMs: positiveInteger("OUTBOX_PUBLISHER_LEASE_MS", 30_000),
    enabled: process.env.OUTBOX_PUBLISHER_ENABLED !== "false",
  };
}

export function createOutboxSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  return new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}
