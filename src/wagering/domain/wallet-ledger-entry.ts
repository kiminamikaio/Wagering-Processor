import { Money } from "../../shared/domain/money";
import { InvalidLedgerEntryError, InvalidMoneyAmountError } from "./errors";

export enum LedgerDirection {
  DEBIT = "DEBIT",
  CREDIT = "CREDIT",
}

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type WalletLedgerEntryState = CreateWalletLedgerEntryProps;

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  private readonly createdAtMilliseconds: number;

  private constructor(props: WalletLedgerEntryState) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.money = props.money;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAtMilliseconds = props.createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyAmountError();
    }

    if (props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("The ledger balance after an entry cannot be negative.");
    }

    const expectedBalance =
      props.direction === LedgerDirection.CREDIT
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);

    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError("The ledger entry does not balance.");
    }

    return new WalletLedgerEntry(props);
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMilliseconds);
  }

  isBalanced(): boolean {
    if (
      !this.money.isPositive() ||
      this.balanceAfter.isNegative() ||
      this.money.currency !== this.balanceBefore.currency ||
      this.balanceBefore.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.CREDIT
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }
}
