import {
  ChangeMessageVisibilityCommand,
  ChangeMessageVisibilityCommandOutput,
  DeleteMessageCommand,
  DeleteMessageCommandOutput,
  Message,
  ReceiveMessageCommand,
  ReceiveMessageCommandOutput,
  SendMessageCommand,
  SendMessageCommandOutput,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  BadRequestException,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  IdempotencyConflictError,
  InboxMessageConflictError,
  UnsupportedTransactionKindError,
  WalletNotFoundError,
} from "../../application/errors";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { parseSubmitWagerInput } from "../../../http/http-validation";
import { InvalidMoneyError } from "../../../shared/domain/errors";
import {
  InvalidLedgerEntryError,
  InvalidMoneyAmountError,
  InvalidTransactionStateError,
  InvalidWalletBalanceError,
  InvalidWagerTransactionError,
  MissingReferenceError,
  InvalidReferenceKindError,
} from "../../domain/errors";

export interface SqsTransactionConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  maxNumberOfMessages: number;
  visibilityTimeoutSeconds: number;
  maxReceives: number;
  retryMaxDelaySeconds: number;
  pollIntervalMs: number;
  enabled: boolean;
}

export interface SubmitWagerExecutor {
  execute: SubmitWagerTransactionUseCase["execute"];
}

interface SqsSender {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
  send(command: ChangeMessageVisibilityCommand): Promise<ChangeMessageVisibilityCommandOutput>;
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
  destroy?(): void;
}

interface ParsedEnvelope {
  messageId: string;
  payload: Record<string, unknown>;
  walletId: string;
  input: ReturnType<typeof parseSubmitWagerInput>;
}

class PermanentMessageError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PermanentMessageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return parsed;
}

function parseEnvelope(
  body: string | undefined,
  messageGroupId: string | undefined,
): ParsedEnvelope {
  if (body === undefined) {
    throw new PermanentMessageError("INVALID_JSON", "Message body is missing.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new PermanentMessageError("INVALID_JSON", "Message body is not valid JSON.");
  }
  if (!isRecord(payload)) {
    throw new PermanentMessageError("INVALID_SCHEMA", "Message envelope must be an object.");
  }
  if (typeof payload.messageId !== "string" || payload.messageId.trim().length === 0) {
    throw new PermanentMessageError("INVALID_SCHEMA", "messageId must be a non-empty string.");
  }
  if (payload.type !== "WagerTransactionRequested") {
    throw new PermanentMessageError("INVALID_SCHEMA", "Message type is not supported.");
  }
  if (
    typeof payload.occurredAt !== "string" ||
    Number.isNaN(Date.parse(payload.occurredAt))
  ) {
    throw new PermanentMessageError("INVALID_SCHEMA", "occurredAt must be a valid timestamp.");
  }
  if (!isRecord(payload.data)) {
    throw new PermanentMessageError("INVALID_SCHEMA", "Message data must be an object.");
  }
  if (typeof payload.data.idempotencyKey !== "string") {
    throw new PermanentMessageError(
      "INVALID_SCHEMA",
      "data.idempotencyKey must be a string.",
    );
  }

  let input: ReturnType<typeof parseSubmitWagerInput>;
  try {
    input = parseSubmitWagerInput(payload.data, payload.data.idempotencyKey);
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw new PermanentMessageError("INVALID_SCHEMA", error.message);
    }
    throw error;
  }
  if (messageGroupId !== undefined && messageGroupId !== input.walletId) {
    throw new PermanentMessageError(
      "INVALID_SCHEMA",
      "MessageGroupId must match data.walletId.",
    );
  }

  return {
    messageId: payload.messageId,
    payload,
    walletId: input.walletId,
    input,
  };
}

function permanentErrorCode(error: unknown): string | undefined {
  if (error instanceof PermanentMessageError) {
    return error.errorCode;
  }
  if (error instanceof IdempotencyConflictError) {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error instanceof WalletNotFoundError) {
    return "WALLET_NOT_FOUND";
  }
  if (error instanceof InboxMessageConflictError) {
    return "INBOX_MESSAGE_CONFLICT";
  }
  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidLedgerEntryError ||
    error instanceof InvalidMoneyAmountError ||
    error instanceof InvalidTransactionStateError ||
    error instanceof InvalidWalletBalanceError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof MissingReferenceError ||
    error instanceof InvalidReferenceKindError ||
    error instanceof UnsupportedTransactionKindError
  ) {
    return "INVALID_SCHEMA";
  }
  return undefined;
}

function retryDelaySeconds(receiveCount: number, maximum: number): number {
  return Math.min(maximum, 2 ** Math.min(Math.max(0, receiveCount - 1), 30));
}

export class SqsTransactionConsumer
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(SqsTransactionConsumer.name);
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeTimer: (() => void) | undefined;
  private duplicateMessages = 0;
  private readonly activePolls = new Set<Promise<unknown>>();

  constructor(
    private readonly submitWager: SubmitWagerExecutor,
    private readonly sender: SqsSender,
    private readonly options: SqsTransactionConsumerOptions,
    private readonly ownsSender = false,
    private readonly afterCommit?: () => Promise<void>,
  ) {}

  get duplicateCount(): number {
    return this.duplicateMessages;
  }

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
    await Promise.allSettled([...this.activePolls]);
    await this.loopPromise;
    if (this.ownsSender) {
      this.sender.destroy?.();
    }
  }

  pollOnce(): Promise<{ received: number; duplicates: number }> {
    if (this.stopping) {
      return Promise.resolve({ received: 0, duplicates: 0 });
    }
    const poll = this.receiveAndProcess();
    this.activePolls.add(poll);
    void poll.then(
      () => this.activePolls.delete(poll),
      () => this.activePolls.delete(poll),
    );
    return poll;
  }

  private async receiveAndProcess(): Promise<{
    received: number;
    duplicates: number;
  }> {
    const response = await this.sender.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MaxNumberOfMessages: this.options.maxNumberOfMessages,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    const messages = response.Messages ?? [];
    const duplicatesBefore = this.duplicateMessages;
    const groups = new Map<string, typeof messages>();
    for (const [index, message] of messages.entries()) {
      const key = message.Attributes?.MessageGroupId ?? `__ungrouped-${index}`;
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);
    }

    const results = await Promise.allSettled(
      [...groups.values()].map(async (group) => {
        for (let index = 0; index < group.length; index += 1) {
          const message = group[index]!;
          if (this.stopping) {
            await this.releaseMessage(message);
            continue;
          }
          const continueGroup = await this.processMessage(message);
          if (!continueGroup) {
            for (const unstarted of group.slice(index + 1)) {
              await this.releaseMessage(unstarted);
            }
            return;
          }
        }
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) {
      throw failed.reason;
    }
    return {
      received: messages.length,
      duplicates: this.duplicateMessages - duplicatesBefore,
    };
  }

  private async processMessage(message: Message): Promise<boolean> {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined) {
      this.logger.error("Received an SQS message without a receipt handle.");
      return false;
    }

    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const validReceiveCount =
      Number.isSafeInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1;
    let envelope: ParsedEnvelope;
    try {
      envelope = parseEnvelope(
        message.Body,
        message.Attributes?.MessageGroupId,
      );
    } catch (error) {
      const errorCode = permanentErrorCode(error);
      if (errorCode !== undefined) {
        return this.moveToDlq(message, receiptHandle, errorCode);
      }
      return this.retry(message, receiptHandle, validReceiveCount, error);
    }

    let result: Awaited<ReturnType<SubmitWagerTransactionUseCase["execute"]>>;
    try {
      result = await this.submitWager.execute({
        ...envelope.input,
        inbox: {
          consumerName: this.options.consumerName,
          messageId: envelope.messageId,
          payloadHash: createHash("sha256")
            .update(JSON.stringify(envelope.payload))
            .digest("hex"),
          payload: envelope.payload,
        },
      });
    } catch (error) {
      const errorCode = permanentErrorCode(error);
      if (errorCode !== undefined) {
        return this.moveToDlq(message, receiptHandle, errorCode);
      }
      return this.retry(message, receiptHandle, validReceiveCount, error);
    }

    if (result.inboxDuplicate === true) {
      this.duplicateMessages += 1;
    }
    await this.afterCommit?.();
    return this.deleteMessage(receiptHandle);
  }

  private async retry(
    message: Message,
    receiptHandle: string,
    receiveCount: number,
    error: unknown,
  ): Promise<boolean> {
    if (receiveCount >= this.options.maxReceives) {
      return this.moveToDlq(message, receiptHandle, "MAX_RECEIVES");
    }

    return this.changeVisibility(message, receiptHandle, receiveCount, error);
  }

  private async changeVisibility(
    message: Message,
    receiptHandle: string,
    receiveCount: number,
    error: unknown,
  ): Promise<boolean> {
    const visibilityTimeout = retryDelaySeconds(
      Number.isSafeInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1,
      this.options.retryMaxDelaySeconds,
    );
    try {
      await this.sender.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
    } catch (visibilityError) {
      this.logger.warn(
        `Could not extend visibility for SQS message: ${this.errorSummary(visibilityError)}`,
      );
    }
    this.logger.warn(
      `Transient SQS consumer failure (receive ${receiveCount}): ${this.errorSummary(error)}`,
    );
    return false;
  }

  private async moveToDlq(
    message: Message,
    receiptHandle: string,
    errorCode: string,
  ): Promise<boolean> {
    const groupId = message.Attributes?.MessageGroupId ?? "invalid-message";
    try {
      await this.sender.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? "",
          MessageGroupId: groupId,
          MessageDeduplicationId: `${message.MessageId ?? crypto.randomUUID()}-${errorCode}`,
          MessageAttributes: {
            errorCode: { DataType: "String", StringValue: errorCode },
            consumerName: {
              DataType: "String",
              StringValue: this.options.consumerName,
            },
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Could not send SQS message to DLQ: ${this.errorSummary(error)}`,
      );
      return this.changeVisibility(
        message,
        receiptHandle,
        Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        error,
      );
    }
    return this.deleteMessage(receiptHandle);
  }

  private async deleteMessage(receiptHandle: string): Promise<boolean> {
    try {
      await this.sender.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `SQS message delete failed after processing; redelivery is safe: ${this.errorSummary(error)}`,
      );
      return false;
    }
  }

  private async releaseMessage(
    message: Message,
  ): Promise<void> {
    if (message.ReceiptHandle === undefined) {
      return;
    }
    try {
      await this.sender.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Could not release unstarted SQS message: ${this.errorSummary(error)}`,
      );
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error(`SQS consumer poll failed: ${this.errorSummary(error)}`);
      }
      if (!this.stopping) {
        await new Promise<void>((resolve) => {
          this.wakeTimer = resolve;
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.wakeTimer = undefined;
            resolve();
          }, this.options.pollIntervalMs);
        });
      }
    }
  }

  private errorSummary(error: unknown): string {
    if (error instanceof Error) {
      return error.name;
    }
    return "UnknownError";
  }
}

export function sqsTransactionConsumerOptionsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SqsTransactionConsumerOptions {
  const endpoint = env.SQS_ENDPOINT ?? "http://localhost:4566";
  return {
    queueUrl:
      env.SQS_QUEUE_URL ??
      `${endpoint.replace(/\/$/, "")}/000000000000/wager-transactions.fifo`,
    dlqUrl:
      env.SQS_DLQ_URL ??
      `${endpoint.replace(/\/$/, "")}/000000000000/wager-transactions-dlq.fifo`,
    consumerName: env.SQS_CONSUMER_NAME ?? "wager-transactions",
    waitTimeSeconds: positiveInteger(env, "SQS_WAIT_TIME_SECONDS", 20, 20),
    maxNumberOfMessages: positiveInteger(
      env,
      "SQS_MAX_NUMBER_OF_MESSAGES",
      10,
      10,
    ),
    visibilityTimeoutSeconds: positiveInteger(
      env,
      "SQS_VISIBILITY_TIMEOUT_SECONDS",
      30,
      43_200,
    ),
    maxReceives: positiveInteger(env, "SQS_MAX_RECEIVES", 5),
    retryMaxDelaySeconds: positiveInteger(
      env,
      "SQS_RETRY_MAX_DELAY_SECONDS",
      300,
      43_200,
    ),
    pollIntervalMs: positiveInteger(env, "SQS_POLL_INTERVAL_MS", 1_000),
    enabled: env.SQS_CONSUMER_ENABLED === "true",
  };
}
