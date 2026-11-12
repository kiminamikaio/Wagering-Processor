import { CurrencyMismatchError } from "../../shared/domain/errors";

export { CurrencyMismatchError };

export enum FailureCode {
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  REVERSAL_WOULD_OVERDRAW = "REVERSAL_WOULD_OVERDRAW",
  REFERENCE_NOT_FOUND = "REFERENCE_NOT_FOUND",
  REFERENCE_MISMATCH = "REFERENCE_MISMATCH",
  INVALID_REFERENCE_KIND = "INVALID_REFERENCE_KIND",
  AMOUNT_MISMATCH = "AMOUNT_MISMATCH",
  ALREADY_REVERSED = "ALREADY_REVERSED",
  CURRENCY_MISMATCH = "CURRENCY_MISMATCH",
  PLAYER_MISMATCH = "PLAYER_MISMATCH",
}

export class InsufficientBalanceError extends Error {
  readonly failureCode = FailureCode.INSUFFICIENT_FUNDS;

  constructor() {
    super("The wallet balance is insufficient for this debit.");
    this.name = "InsufficientBalanceError";
  }
}

export class InvalidMoneyAmountError extends Error {
  constructor(message = "The money amount must be greater than zero.") {
    super(message);
    this.name = "InvalidMoneyAmountError";
  }
}

export class InvalidWalletBalanceError extends Error {
  constructor() {
    super("A wallet balance cannot be negative.");
    this.name = "InvalidWalletBalanceError";
  }
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerEntryError";
  }
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionError";
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(
    readonly currentStatus: string,
    readonly requestedStatus: string,
  ) {
    super(`Cannot transition a ${currentStatus} transaction to ${requestedStatus}.`);
    this.name = "InvalidTransactionStateError";
  }
}

export class MissingReferenceError extends Error {
  constructor() {
    super("A processed rollback requires its referenced transaction.");
    this.name = "MissingReferenceError";
  }
}

export class InvalidReferenceKindError extends Error {
  constructor(kind: string) {
    super(`A rollback cannot reference a ${kind} transaction.`);
    this.name = "InvalidReferenceKindError";
  }
}
