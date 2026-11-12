import { describe, expect, it } from "bun:test";
import { Money } from "../../shared/domain/money";
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidMoneyAmountError,
} from "./errors";
import { LedgerDirection } from "./wallet-ledger-entry";
import { Wallet } from "./wallet";

const openedAt = new Date("2026-01-01T00:00:00.000Z");
const updatedAt = new Date("2026-01-02T00:00:00.000Z");

function openWallet(initialBalance = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: initialBalance, currency: "BRL" }),
    at: openedAt,
  });
}

describe("Wallet", () => {
  it("debits and returns a ledger entry matching the updated balance", () => {
    const wallet = openWallet();
    const entry = wallet.debit(
      Money.from({ amount: "25.50", currency: "BRL" }),
      "transaction-1",
      "entry-1",
      updatedAt,
    );

    expect(entry.direction).toBe(LedgerDirection.DEBIT);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("74.50");
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe("74.50");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  it("credits and returns a ledger entry matching the updated balance", () => {
    const wallet = openWallet("10.00");
    const entry = wallet.credit(
      Money.from({ amount: "3.25", currency: "BRL" }),
      "transaction-2",
      "entry-2",
      updatedAt,
    );

    expect(entry.direction).toBe(LedgerDirection.CREDIT);
    expect(entry.balanceBefore.toString()).toBe("10.00");
    expect(entry.balanceAfter.toString()).toBe("13.25");
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe("13.25");
    expect(wallet.version).toBe(2);
  });

  it("rejects a debit that would make the balance negative without changing state", () => {
    const wallet = openWallet("5.00");

    expect(() =>
      wallet.debit(
        Money.from({ amount: "5.01", currency: "BRL" }),
        "transaction-3",
        "entry-3",
        updatedAt,
      ),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toString()).toBe("5.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  it("rejects a different currency and non-positive amounts", () => {
    const wallet = openWallet();

    expect(() =>
      wallet.credit(
        Money.from({ amount: "1.00", currency: "USD" }),
        "transaction-4",
        "entry-4",
        updatedAt,
      ),
    ).toThrow(CurrencyMismatchError);

    for (const money of [
      Money.zero("BRL"),
      Money.fromCents(-1n, "BRL"),
    ]) {
      expect(() => wallet.credit(money, "transaction-5", "entry-5", updatedAt)).toThrow(
        InvalidMoneyAmountError,
      );
    }
  });

  it("increments version only when a successful balance change occurs", () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);

    wallet.credit(
      Money.from({ amount: "1.00", currency: "BRL" }),
      "transaction-6",
      "entry-6",
      updatedAt,
    );
    expect(wallet.version).toBe(2);

    expect(() =>
      wallet.debit(
        Money.from({ amount: "102.00", currency: "BRL" }),
        "transaction-7",
        "entry-7",
        new Date("2026-01-03T00:00:00.000Z"),
      ),
    ).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toString()).toBe("101.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  it("rehydrates without generating or changing timestamps", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-2",
      playerId: "player-2",
      currency: "BRL",
      balance: Money.from({ amount: "4.00", currency: "BRL" }),
      version: 7,
      createdAt: openedAt,
      updatedAt,
    });

    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe("4.00");
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });
});
