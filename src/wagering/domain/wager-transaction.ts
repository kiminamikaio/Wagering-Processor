import { Money } from "../../shared/domain/money";
import {
  FailureCode,
  InvalidMoneyAmountError,
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  MissingReferenceError,
} from "./errors";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  OPENING = "OPENING",
  BET = "BET",
  WIN = "WIN",
  LOSS = "LOSS",
  REFUND = "REFUND",
  ROLLBACK = "ROLLBACK",
}

export enum WagerTransactionStatus {
  PENDING = "PENDING",
  PENDING_REFERENCE = "PENDING_REFERENCE",
  PROCESSED = "PROCESSED",
  REJECTED = "REJECTED",
  FAILED = "FAILED",
}

const VALID_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  [WagerTransactionStatus.PENDING]: [
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
    WagerTransactionStatus.PENDING_REFERENCE,
  ],
  [WagerTransactionStatus.PENDING_REFERENCE]: [
    WagerTransactionStatus.PROCESSED,
    WagerTransactionStatus.REJECTED,
    WagerTransactionStatus.FAILED,
  ],
  [WagerTransactionStatus.PROCESSED]: [],
  [WagerTransactionStatus.REJECTED]: [],
  [WagerTransactionStatus.FAILED]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  private readonly createdAtMilliseconds: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAtMilliseconds: number | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAtMilliseconds = state.createdAt.getTime();
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAtMilliseconds = state.processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.OPENING) {
      throw new InvalidWagerTransactionError("OPENING transactions are internal.");
    }

    this.assertValidCreation(props);
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.PENDING,
    });
  }

  static createOpening(
    props: Omit<CreateWagerTransactionProps, "kind">,
  ): WagerTransaction {
    this.assertPositiveAmount(props.money);
    return new WagerTransaction({
      ...props,
      kind: WagerTransactionKind.OPENING,
      status: WagerTransactionStatus.PENDING,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAtMilliseconds === undefined
      ? undefined
      : new Date(this._processedAtMilliseconds);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMilliseconds);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertTransition(WagerTransactionStatus.PROCESSED);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new MissingReferenceError();
    }

    this._status = WagerTransactionStatus.PROCESSED;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAtMilliseconds = at.getTime();
  }

  markPendingReference(): void {
    this.assertTransition(WagerTransactionStatus.PENDING_REFERENCE);
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        this._status,
        WagerTransactionStatus.PENDING_REFERENCE,
      );
    }

    this._status = WagerTransactionStatus.PENDING_REFERENCE;
  }

  reject(code: FailureCode): void {
    this.assertTransition(WagerTransactionStatus.REJECTED);
    this._failureCode = code;
    this._status = WagerTransactionStatus.REJECTED;
  }

  fail(code: FailureCode): void {
    this.assertTransition(WagerTransactionStatus.FAILED);
    this._failureCode = code;
    this._status = WagerTransactionStatus.FAILED;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.PROCESSED ||
      this._status === WagerTransactionStatus.REJECTED ||
      this._status === WagerTransactionStatus.FAILED
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.LOSS;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.REFUND ||
      this.kind === WagerTransactionKind.ROLLBACK
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.OPENING:
      case WagerTransactionKind.WIN:
      case WagerTransactionKind.REFUND:
        return LedgerDirection.CREDIT;
      case WagerTransactionKind.BET:
        return LedgerDirection.DEBIT;
      case WagerTransactionKind.LOSS:
        return undefined;
      case WagerTransactionKind.ROLLBACK:
        return this.rollbackDirection(reference);
    }
  }

  private rollbackDirection(reference?: WagerTransaction): LedgerDirection {
    if (reference === undefined) {
      throw new MissingReferenceError();
    }

    switch (reference.kind) {
      case WagerTransactionKind.BET:
        return LedgerDirection.CREDIT;
      case WagerTransactionKind.WIN:
      case WagerTransactionKind.REFUND:
        return LedgerDirection.DEBIT;
      default:
        throw new InvalidReferenceKindError(reference.kind);
    }
  }

  private assertTransition(nextStatus: WagerTransactionStatus): void {
    if (!VALID_TRANSITIONS[this._status].includes(nextStatus)) {
      throw new InvalidTransactionStateError(this._status, nextStatus);
    }
  }

  private static assertValidCreation(props: CreateWagerTransactionProps): void {
    this.assertPositiveAmount(props.money);

    const requiresReference =
      props.kind === WagerTransactionKind.REFUND ||
      props.kind === WagerTransactionKind.ROLLBACK;
    if (
      requiresReference &&
      (props.referenceExternalTransactionId === undefined ||
        props.referenceExternalTransactionId.length === 0)
    ) {
      throw new InvalidWagerTransactionError(
        `${props.kind} transactions require a referenceExternalTransactionId.`,
      );
    }
  }

  private static assertPositiveAmount(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidMoneyAmountError();
    }
  }
}
