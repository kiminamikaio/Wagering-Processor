import { describe, expect, it } from "bun:test";
import { Money } from "../../shared/domain/money";
import { InvalidLedgerEntryError, InvalidMoneyAmountError } from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

const createdAt = new Date("2026-01-02T03:04:05.000Z");

function createEntry(
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "transaction-1",
    direction: LedgerDirection.DEBIT,
    money: Money.from({ amount: "2.50", currency: "BRL" }),
    balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
    balanceAfter: Money.from({ amount: "7.50", currency: "BRL" }),
    createdAt,
    ...overrides,
  });
}

describe("WalletLedgerEntry", () => {
  it("creates balanced debit and credit entries", () => {
    const debit = createEntry();
    const credit = createEntry({
      direction: LedgerDirection.CREDIT,
      balanceBefore: Money.from({ amount: "7.50", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "10.00", currency: "BRL" }),
    });

    expect(debit.isBalanced()).toBe(true);
    expect(credit.isBalanced()).toBe(true);
  });

  it("rejects incorrect arithmetic and negative resulting balances", () => {
    expect(() =>
      createEntry({
        balanceAfter: Money.from({ amount: "7.49", currency: "BRL" }),
      }),
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      createEntry({
        balanceBefore: Money.from({ amount: "1.00", currency: "BRL" }),
        balanceAfter: Money.fromCents(-150n, "BRL"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it("rejects zero and negative amounts", () => {
    for (const money of [
      Money.zero("BRL"),
      Money.fromCents(-1n, "BRL"),
    ]) {
      expect(() => createEntry({ money })).toThrow(InvalidMoneyAmountError);
    }
  });

  it("is structurally immutable, including its creation time", () => {
    const entry = createEntry();

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry, "id", "changed")).toBe(false);
    entry.createdAt.setTime(0);
    expect(entry.createdAt).toEqual(createdAt);
  });

  it("rehydrates persisted entries without changing their state", () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: "persisted-entry",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.DEBIT,
      money: Money.from({ amount: "2.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "10.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "9.00", currency: "BRL" }),
      createdAt,
    });

    expect(entry.id).toBe("persisted-entry");
    expect(entry.isBalanced()).toBe(false);
  });
});
