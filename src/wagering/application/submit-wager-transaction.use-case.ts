import { Money } from "../../shared/domain/money";
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientBalanceError,
} from "../domain/errors";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { computePayloadHash } from "./compute-payload-hash";
import {
  ApplyWagerReversalService,
  processedEvent,
  rejectedEvent,
} from "./apply-wager-reversal.service";
import {
  IdempotencyConflictError,
  UnsupportedTransactionKindError,
  WalletNotFoundError,
  isPostgresUniqueViolation,
} from "./errors";
import {
  MoneyProps,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
  enqueueIntegrationEvent,
} from "./events/integration-events";
import {
  Clock,
  IdGenerator,
  InboxMessageInput,
  WageringUnitOfWork,
} from "./ports/wagering-unit-of-work";
import { WagerTransactionReferenceResolver } from "./wager-transaction-reference-resolver";
import { REFERENCE_RETRY_BASE_MS } from "./reference-retry-policy";
import { currentLogContext, runWithLogContext } from "../../observability/correlation-context";
import { jsonLogger } from "../../observability/json-logger";
import { metricsRegistry } from "../../observability/metrics-registry";

export interface SubmitWagerTransactionInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inbox?: InboxMessageInput;
}

export interface SubmitWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  inboxDuplicate?: boolean;
}

export class SubmitWagerTransactionUseCase {
  private readonly referenceResolver = new WagerTransactionReferenceResolver();
  private readonly reversalApplier: ApplyWagerReversalService;

  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {
    this.reversalApplier = new ApplyWagerReversalService(idGenerator);
  }

  async execute(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    const channel = input.inbox === undefined ? "http" : "sqs";
    const startedAt = performance.now();
    try {
      const result = await runWithLogContext(
        {
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId }),
          walletId: input.walletId,
          providerId: input.providerId,
        },
        () => this.executeTransaction(input),
      );
      metricsRegistry.recordTransaction(
        result.status,
        input.kind,
        channel,
        (performance.now() - startedAt) / 1_000,
      );
      const fields = {
        ...currentLogContext(),
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
      };
      if (result.idempotentReplay || result.inboxDuplicate) {
        metricsRegistry.increment("idempotency_duplicates_total", { channel });
        jsonLogger.event(
          "info",
          "Wager transaction duplicate detected.",
          fields,
          "SubmitWagerTransactionUseCase",
        );
      } else {
        const outcome =
          result.status === WagerTransactionStatus.PROCESSED
            ? "processed"
            : result.status === WagerTransactionStatus.REJECTED
              ? "rejected"
              : "pending";
        jsonLogger.event(
          "info",
          `Wager transaction ${outcome}.`,
          fields,
          "SubmitWagerTransactionUseCase",
        );
      }
      return result;
    } catch (error) {
      if (postgresErrorCode(error) === "55P03") {
        metricsRegistry.increment("lock_conflicts_total");
        jsonLogger.event(
          "warn",
          "Wallet lock timeout.",
          {
            ...currentLogContext(),
            walletId: input.walletId,
            providerId: input.providerId,
          },
          "SubmitWagerTransactionUseCase",
        );
      }
      throw error;
    }
  }

  private async executeTransaction(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    if (
      input.kind !== WagerTransactionKind.BET &&
      input.kind !== WagerTransactionKind.WIN &&
      input.kind !== WagerTransactionKind.LOSS &&
      input.kind !== WagerTransactionKind.REFUND &&
      input.kind !== WagerTransactionKind.ROLLBACK
    ) {
      throw new UnsupportedTransactionKindError(input.kind);
    }

    const money = Money.from(input.money);
    const payloadHash = computePayloadHash(input);

    return this.unitOfWork.run(async (tx) => {
      if (input.inbox !== undefined) {
        const inserted = await tx.inbox.insertIfAbsent(input.inbox);
        if (!inserted) {
          const existing = await tx.transactions.findByIdempotencyKeyOrExternalId(
            input.providerId,
            input.externalTransactionId,
            input.idempotencyKey,
          );
          if (existing === undefined) {
            throw new Error("A processed inbox message has no wager transaction.");
          }
          return {
            transactionId: existing.transaction.id,
            status: existing.transaction.status,
            idempotentReplay: true,
            inboxDuplicate: true,
            ...(existing.observedBalance === undefined
              ? {}
              : { balance: existing.observedBalance.toJSON() }),
            ...(existing.transaction.failureCode === undefined
              ? {}
              : { failureCode: existing.transaction.failureCode }),
          };
        }
      }

      const complete = async (
        result: SubmitWagerTransactionOutput,
      ): Promise<SubmitWagerTransactionOutput> => {
        if (input.inbox === undefined) {
          return result;
        }
        await tx.inbox.markProcessed(
          input.inbox.consumerName,
          input.inbox.messageId,
        );
        return { ...result, inboxDuplicate: false };
      };

      const wallet = await tx.wallets.findByIdForUpdate(input.walletId);
      if (wallet === undefined) {
        throw new WalletNotFoundError(input.walletId);
      }

      const existing = await tx.transactions.findByIdempotencyKeyOrExternalId(
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
      );
      if (existing !== undefined) {
        if (
          existing.transaction.payloadHash !== payloadHash ||
          existing.transaction.idempotencyKey !== input.idempotencyKey
        ) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }

        return complete({
          transactionId: existing.transaction.id,
          status: existing.transaction.status,
          idempotentReplay: true,
          ...(existing.observedBalance === undefined
            ? {}
            : { balance: existing.observedBalance.toJSON() }),
          ...(existing.transaction.failureCode === undefined
            ? {}
            : { failureCode: existing.transaction.failureCode }),
        });
      }

      const createdAt = this.clock.now();
      const transaction = WagerTransaction.create({
        id: this.idGenerator.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt,
      });
      const correlationId =
        input.correlationId ??
        currentLogContext().correlationId ??
        transaction.id;

      try {
        await tx.transactions.insert(transaction);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        throw error;
      }

      let reference: WagerTransaction | undefined;
      if (transaction.requiresReference()) {
        const referenceExternalTransactionId =
          transaction.referenceExternalTransactionId;
        if (referenceExternalTransactionId === undefined) {
          throw new Error("A reversal must have a reference external transaction ID.");
        }

        reference = await this.referenceResolver.resolve(
          tx,
          transaction.providerId,
          referenceExternalTransactionId,
        );
        if (reference === undefined) {
          transaction.markPendingReference(
            new Date(createdAt.getTime() + REFERENCE_RETRY_BASE_MS),
          );
          await tx.transactions.save(transaction, undefined);
          await enqueueIntegrationEvent(
            tx,
            new WagerTransactionPendingReference({
              eventId: this.idGenerator.next(),
              aggregateId: transaction.walletId,
              correlationId,
              occurredAt: createdAt,
              data: {
                transactionId: transaction.id,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                playerId: transaction.playerId,
                walletId: transaction.walletId,
                referenceExternalTransactionId,
              },
            }),
          );

          return complete({
            transactionId: transaction.id,
            status: transaction.status,
            idempotentReplay: false,
          });
        }

        const applied = await this.reversalApplier.apply(
          tx,
          transaction,
          wallet,
          reference,
          correlationId,
          createdAt,
        );
        return complete({
          transactionId: transaction.id,
          status: transaction.status,
          balance: applied.balance.toJSON(),
          idempotentReplay: false,
          ...(applied.failureCode === undefined
            ? {}
            : { failureCode: applied.failureCode }),
        });
      } else if (input.playerId !== wallet.playerId) {
        transaction.reject(FailureCode.PLAYER_MISMATCH);
      } else if (input.money.currency !== wallet.currency) {
        transaction.reject(FailureCode.CURRENCY_MISMATCH);
      }

      const versionBefore = wallet.version;
      const balanceBefore = wallet.balance;
      let ledgerEntry: WalletLedgerEntry | undefined;

      if (transaction.status !== WagerTransactionStatus.REJECTED) {
        try {
          switch (transaction.kind) {
            case WagerTransactionKind.BET:
              ledgerEntry = wallet.debit(
                money,
                transaction.id,
                this.idGenerator.next(),
                createdAt,
              );
              break;
            case WagerTransactionKind.WIN:
              ledgerEntry = wallet.credit(
                money,
                transaction.id,
                this.idGenerator.next(),
                createdAt,
              );
              break;
            case WagerTransactionKind.LOSS:
              break;
            default:
              throw new UnsupportedTransactionKindError(transaction.kind);
          }
        } catch (error) {
          if (error instanceof InsufficientBalanceError) {
            transaction.reject(FailureCode.INSUFFICIENT_FUNDS);
          } else if (error instanceof CurrencyMismatchError) {
            transaction.reject(FailureCode.CURRENCY_MISMATCH);
          } else {
            throw error;
          }
        }
      }

      if (transaction.status === WagerTransactionStatus.REJECTED) {
        await tx.transactions.save(transaction, wallet.balance);
        await enqueueIntegrationEvent(
          tx,
          rejectedEvent(
            transaction,
            wallet.balance,
            this.idGenerator.next(),
            correlationId,
            createdAt,
          ),
        );

        return complete({
          transactionId: transaction.id,
          status: transaction.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          failureCode: transaction.failureCode,
        });
      }

      if (ledgerEntry !== undefined) {
        await tx.ledger.insert(ledgerEntry);
        await tx.wallets.save(wallet, versionBefore);
      }
      transaction.markProcessed(reference?.id, createdAt);
      await tx.transactions.save(transaction, wallet.balance);
      await enqueueIntegrationEvent(
        tx,
        processedEvent(
          transaction,
          wallet.balance,
          this.idGenerator.next(),
          correlationId,
          createdAt,
        ),
      );

      if (!balanceBefore.equals(wallet.balance)) {
        if (ledgerEntry === undefined) {
          throw new Error("A changed wallet balance must have a ledger entry.");
        }

        await enqueueIntegrationEvent(
          tx,
          new WalletBalanceChanged({
            eventId: this.idGenerator.next(),
            aggregateId: wallet.id,
            correlationId,
            occurredAt: createdAt,
            data: {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction: ledgerEntry.direction,
              money: ledgerEntry.money.toJSON(),
              balanceBefore: ledgerEntry.balanceBefore.toJSON(),
              balanceAfter: ledgerEntry.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        );
      }

      return complete({
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      });
    });
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
