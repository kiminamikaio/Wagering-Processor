import {
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  Clock,
  IdGenerator,
  WageringUnitOfWork,
} from "../../application/ports/wagering-unit-of-work";
import { ApplyWagerReversalService } from "../../application/apply-wager-reversal.service";
import {
  REFERENCE_RETRY_BASE_MS,
  referenceRetryDelayMs,
} from "../../application/reference-retry-policy";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
import { WalletNotFoundError } from "../../application/errors";
import { runWithLogContext } from "../../../observability/correlation-context";
import { jsonLogger } from "../../../observability/json-logger";
import { metricsRegistry } from "../../../observability/metrics-registry";

export interface PendingReferenceWorkerOptions {
  batchSize: number;
  intervalMs: number;
  baseDelayMs: number;
  maxAttempts: number;
  ttlMs: number;
  enabled: boolean;
}

export interface PendingReferenceRunResult {
  claimed: number;
  resolved: number;
  rescheduled: number;
  rejected: number;
  skipped: number;
}

type ItemResult = "resolved" | "rescheduled" | "rejected" | "skipped";

export class PendingReferenceWorker
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private readonly reversalApplier: ApplyWagerReversalService;
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeTimer: (() => void) | undefined;

  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly clock: Clock,
    ids: IdGenerator,
    private readonly options: PendingReferenceWorkerOptions,
    private readonly random: () => number = Math.random,
  ) {
    this.reversalApplier = new ApplyWagerReversalService(ids);
  }

  onModuleInit(): void {
    if (!this.options.enabled) {
      return;
    }

    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.wakeTimer?.();
    }
    await this.loopPromise;
  }

  async runOnce(providerId?: string): Promise<PendingReferenceRunResult> {
    const now = this.clock.now();
    const candidates = await this.unitOfWork.run((tx) =>
      tx.transactions.findDueReferenceIds(
        now,
        this.options.batchSize,
        providerId,
      ),
    );
    const result: PendingReferenceRunResult = {
      claimed: candidates.length,
      resolved: 0,
      rescheduled: 0,
      rejected: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      const itemResult = await this.process(candidate.id, candidate.walletId);
      result[itemResult] += 1;
    }

    return result;
  }

  private async process(id: string, walletId: string): Promise<ItemResult> {
    return runWithLogContext(
      { correlationId: id, transactionId: id, walletId },
      async () => {
        const result = await this.unitOfWork.run(async (tx) => {
          const wallet = await tx.wallets.findByIdForUpdate(walletId);
          if (wallet === undefined) {
            throw new WalletNotFoundError(walletId);
          }

          const transaction = await tx.transactions.findByIdForUpdate(id);
          if (transaction === undefined || transaction.walletId !== walletId) {
            throw new Error(
              `Pending reference transaction ${id} is missing or changed wallets.`,
            );
          }

          const now = this.clock.now();
          if (
            transaction.status !== WagerTransactionStatus.PENDING_REFERENCE ||
            transaction.referenceNextAttemptAt === undefined ||
            transaction.referenceNextAttemptAt.getTime() > now.getTime()
          ) {
            return "skipped";
          }

          const expired =
            now.getTime() - transaction.createdAt.getTime() >= this.options.ttlMs;
          if (expired || transaction.referenceAttempts >= this.options.maxAttempts) {
            await this.reversalApplier.rejectMissingReference(
              tx,
              transaction,
              wallet,
              transaction.id,
              now,
            );
            return "rejected";
          }

          const referenceExternalTransactionId =
            transaction.referenceExternalTransactionId;
          if (referenceExternalTransactionId === undefined) {
            throw new Error(
              `Pending reference transaction ${transaction.id} has no reference identifier.`,
            );
          }
          const reference = await tx.transactions.findReferenceForUpdate(
            transaction.providerId,
            referenceExternalTransactionId,
          );

          if (reference !== undefined) {
            const applied = await this.reversalApplier.apply(
              tx,
              transaction,
              wallet,
              reference,
              transaction.id,
              now,
            );
            return applied.failureCode === undefined ? "resolved" : "rejected";
          }

          const attempts = transaction.referenceAttempts + 1;
          const retryAt =
            now.getTime() +
            referenceRetryDelayMs(
              attempts,
              this.random,
              this.options.baseDelayMs,
            );
          const expiresAt = transaction.createdAt.getTime() + this.options.ttlMs;
          const exhausted =
            attempts >= this.options.maxAttempts || now.getTime() >= expiresAt;
          const nextAttemptAt = new Date(Math.min(retryAt, expiresAt));
          transaction.recordReferenceAttempt(
            attempts,
            exhausted ? undefined : nextAttemptAt,
          );
          if (exhausted) {
            await this.reversalApplier.rejectMissingReference(
              tx,
              transaction,
              wallet,
              transaction.id,
              now,
            );
            return "rejected";
          }

          await tx.transactions.save(transaction, undefined);
          return "rescheduled";
        });
        if (result === "rescheduled") {
          metricsRegistry.increment("retries_total", { component: "pending_reference" });
          jsonLogger.event(
            "warn",
            "Pending reference retry scheduled.",
            { transactionId: id, walletId },
            "PendingReferenceWorker",
          );
        } else if (result === "resolved") {
          jsonLogger.event(
            "info",
            "Pending wager transaction processed.",
            { transactionId: id, walletId },
            "PendingReferenceWorker",
          );
        } else if (result === "rejected") {
          jsonLogger.event(
            "info",
            "Pending wager transaction rejected.",
            { transactionId: id, walletId },
            "PendingReferenceWorker",
          );
        }
        return result;
      },
    );
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        const code = postgresErrorCode(error);
        if (code === "55P03") {
          metricsRegistry.increment("lock_conflicts_total");
          jsonLogger.event(
            "warn",
            "Wallet lock timeout.",
            {},
            "PendingReferenceWorker",
          );
        }
        jsonLogger.event(
          "error",
          `Pending reference worker run failed: ${error instanceof Error ? error.name : "UnknownError"}.`,
          {},
          "PendingReferenceWorker",
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

function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    if ("cause" in current) {
      current = current.cause;
    } else if ("originalError" in current) {
      current = current.originalError;
    } else if ("driverException" in current) {
      current = current.driverException;
    } else {
      return undefined;
    }
  }
  return undefined;
}

export function pendingReferenceWorkerOptionsFromEnvironment(): PendingReferenceWorkerOptions {
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

  return {
    batchSize: positiveInteger("PENDING_REFERENCE_WORKER_BATCH_SIZE", 100),
    intervalMs: positiveInteger("PENDING_REFERENCE_WORKER_INTERVAL_MS", 1_000),
    baseDelayMs: REFERENCE_RETRY_BASE_MS,
    maxAttempts: positiveInteger("REFERENCE_MAX_ATTEMPTS", 8),
    ttlMs: positiveInteger("REFERENCE_TTL", 900_000),
    enabled: process.env.PENDING_REFERENCE_WORKER_ENABLED === "true",
  };
}
