import { Money } from "../../../shared/domain/money";

export function moneyToCents(money: Money): string {
  return money.toCents().toString();
}

export function moneyFromCents(cents: string, currency: string): Money {
  return Money.fromCents(BigInt(cents), currency);
}
