import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyInput {
  amount: string;
  currency: string;
}

export class Money {
  private readonly cents: bigint;
  readonly currency: string;

  private constructor(cents: bigint, currency: string) {
    if (typeof cents !== "bigint") {
      throw new InvalidMoneyError("Money must be represented as integer cents.");
    }

    Money.validateCurrency(currency);
    this.cents = cents;
    this.currency = currency;
    Object.freeze(this);
  }

  static from(input: MoneyInput): Money {
    if (input === null || typeof input !== "object") {
      throw new InvalidMoneyError("Money input must include an amount and currency.");
    }

    const { amount, currency } = input;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("Amount must be a non-negative decimal string.");
    }

    const match = AMOUNT_PATTERN.exec(amount);
    if (match === null || match[0] !== amount) {
      throw new InvalidMoneyError("Amount must have at most two decimal places and no sign.");
    }

    const wholeCents = BigInt(match[1]) * 100n;
    const fractionalCents = BigInt((match[2] ?? "").padEnd(2, "0"));
    return new Money(wholeCents + fractionalCents, currency);
  }

  static zero(currency: string): Money {
    return Money.fromCents(0n, currency);
  }

  static fromCents(cents: bigint, currency: string): Money {
    return new Money(cents, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toCents(): bigint {
    return this.cents;
  }

  toString(): string {
    const isNegative = this.cents < 0n;
    const absoluteCents = isNegative ? -this.cents : this.cents;
    const whole = absoluteCents / 100n;
    const fractional = (absoluteCents % 100n).toString().padStart(2, "0");

    return `${isNegative ? "-" : ""}${whole}.${fractional}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validateCurrency(currency: string): void {
    const match = typeof currency === "string" ? CURRENCY_PATTERN.exec(currency) : null;
    if (match === null || match[0] !== currency) {
      throw new InvalidMoneyError("Currency must be a three-letter uppercase ISO-4217 code.");
    }
  }
}
