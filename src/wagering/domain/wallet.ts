import { CurrencyMismatchError, InvalidMoneyAmountError, InvalidWalletBalanceError, InsufficientBalanceError } from "./errors";
import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  private readonly createdAtMilliseconds: number;
  private _balance: Money;
  private _version: number;
  private updatedAtMilliseconds: number;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this._balance = state.balance;
    this._version = state.version;
    this.createdAtMilliseconds = state.createdAt.getTime();
    this.updatedAtMilliseconds = state.updatedAt.getTime();
  }

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletBalanceError();
    }

    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtMilliseconds);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtMilliseconds);
  }

  debit(
    money: Money,
    transactionId: string,
    entryId: string,
    at: Date,
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);
    this.assertPositiveAmount(money);

    const balanceAfter = this._balance.subtract(money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientBalanceError();
    }

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.DEBIT,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });

    this.applyBalance(balanceAfter, at);
    return entry;
  }

  credit(
    money: Money,
    transactionId: string,
    entryId: string,
    at: Date,
  ): WalletLedgerEntry {
    this.assertSameCurrency(money);
    this.assertPositiveAmount(money);

    const balanceAfter = this._balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.CREDIT,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });

    this.applyBalance(balanceAfter, at);
    return entry;
  }

  private applyBalance(balanceAfter: Money, at: Date): void {
    if (!this._balance.equals(balanceAfter)) {
      this._balance = balanceAfter;
      this._version += 1;
      this.updatedAtMilliseconds = at.getTime();
    }
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositiveAmount(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidMoneyAmountError();
    }
  }
}
