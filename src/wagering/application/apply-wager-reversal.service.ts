import { Money } from "../../shared/domain/money";
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientBalanceError,
} from "../domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import {
  IdGenerator,
  WageringTx,
} from "./ports/wagering-unit-of-work";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  enqueueIntegrationEvent,
} from "./events/integration-events";

export interface AppliedReversal {
  balance: Money;
  failureCode?: FailureCode;
}

export function processedEvent(
  transaction: WagerTransaction,
  balance: Money,
  eventId: string,
  correlationId: string,
  occurredAt: Date,
): WagerTransactionProcessed {
  return new WagerTransactionProcessed({
    eventId,
    aggregateId: transaction.walletId,
    correlationId,
    occurredAt,
    data: {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      balance: balance.toJSON(),
    },
  });
}

export function rejectedEvent(
  transaction: WagerTransaction,
  balance: Money,
  eventId: string,
  correlationId: string,
  occurredAt: Date,
): WagerTransactionRejected {
  if (transaction.failureCode === undefined) {
    throw new Error("A rejected wager transaction must have a failure code.");
  }

  return new WagerTransactionRejected({
    eventId,
    aggregateId: transaction.walletId,
    correlationId,
    occurredAt,
    data: {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      balance: balance.toJSON(),
      failureCode: transaction.failureCode,
    },
  });
}

export class ApplyWagerReversalService {
  constructor(private readonly idGenerator: IdGenerator) {}

  async apply(
    tx: WageringTx,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction,
    correlationId: string,
    at: Date,
  ): Promise<AppliedReversal> {
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.playerId !== wallet.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.walletId !== wallet.id ||
      reference.money.currency !== transaction.money.currency ||
      wallet.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId ||
      reference.status !== WagerTransactionStatus.PROCESSED
    ) {
      transaction.reject(FailureCode.REFERENCE_MISMATCH);
    } else if (
      transaction.kind === WagerTransactionKind.REFUND
        ? reference.kind !== WagerTransactionKind.BET
        : reference.kind !== WagerTransactionKind.BET &&
          reference.kind !== WagerTransactionKind.WIN &&
          reference.kind !== WagerTransactionKind.REFUND
    ) {
      transaction.reject(FailureCode.INVALID_REFERENCE_KIND);
    } else if (!reference.money.equals(transaction.money)) {
      transaction.reject(FailureCode.AMOUNT_MISMATCH);
    } else if (await tx.transactions.hasProcessedReversal(reference.id)) {
      transaction.reject(FailureCode.ALREADY_REVERSED);
    }

    if (transaction.status === WagerTransactionStatus.REJECTED) {
      return this.persistRejection(tx, transaction, wallet, correlationId, at);
    }

    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version;
    let ledgerEntry: WalletLedgerEntry;
    try {
      if (transaction.kind === WagerTransactionKind.REFUND) {
        ledgerEntry = wallet.credit(
          transaction.money,
          transaction.id,
          this.idGenerator.next(),
          at,
        );
      } else {
        const direction = transaction.ledgerDirectionFor(reference);
        ledgerEntry =
          direction === LedgerDirection.CREDIT
            ? wallet.credit(
                transaction.money,
                transaction.id,
                this.idGenerator.next(),
                at,
              )
            : wallet.debit(
                transaction.money,
                transaction.id,
                this.idGenerator.next(),
                at,
              );
      }
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        transaction.reject(FailureCode.REVERSAL_WOULD_OVERDRAW);
        return this.persistRejection(tx, transaction, wallet, correlationId, at);
      }
      if (error instanceof CurrencyMismatchError) {
        transaction.reject(FailureCode.CURRENCY_MISMATCH);
        return this.persistRejection(tx, transaction, wallet, correlationId, at);
      }
      throw error;
    }

    await tx.ledger.insert(ledgerEntry);
    await tx.wallets.save(wallet, versionBefore);
    transaction.markProcessed(reference.id, at);
    await tx.transactions.save(transaction, wallet.balance);
    await enqueueIntegrationEvent(
      tx,
      processedEvent(
        transaction,
        wallet.balance,
        this.idGenerator.next(),
        correlationId,
        at,
      ),
    );
    if (!balanceBefore.equals(wallet.balance)) {
      await enqueueIntegrationEvent(
        tx,
        new WalletBalanceChanged({
          eventId: this.idGenerator.next(),
          aggregateId: wallet.id,
          correlationId,
          occurredAt: at,
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

    return { balance: wallet.balance };
  }

  async rejectMissingReference(
    tx: WageringTx,
    transaction: WagerTransaction,
    wallet: Wallet,
    correlationId: string,
    at: Date,
  ): Promise<AppliedReversal> {
    transaction.reject(FailureCode.REFERENCE_NOT_FOUND);
    return this.persistRejection(tx, transaction, wallet, correlationId, at);
  }

  private async persistRejection(
    tx: WageringTx,
    transaction: WagerTransaction,
    wallet: Wallet,
    correlationId: string,
    at: Date,
  ): Promise<AppliedReversal> {
    await tx.transactions.save(transaction, wallet.balance);
    await enqueueIntegrationEvent(
      tx,
      rejectedEvent(
        transaction,
        wallet.balance,
        this.idGenerator.next(),
        correlationId,
        at,
      ),
    );
    return {
      balance: wallet.balance,
      failureCode: transaction.failureCode,
    };
  }
}
