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
              correlationId: input.correlationId ?? transaction.id,
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
          input.correlationId ?? transaction.id,
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

      const correlationId = input.correlationId ?? transaction.id;
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
