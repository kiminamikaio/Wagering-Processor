import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";
import { Money } from "./money";

describe("Money", () => {
  it("adds decimal amounts exactly", () => {
    const result = Money.from({ amount: "0.10", currency: "USD" }).add(
      Money.from({ amount: "0.20", currency: "USD" }),
    );

    expect(result.toString()).toBe("0.30");
    expect(result.toJSON()).toEqual({ amount: "0.30", currency: "USD" });
  });

  it("formats whole amounts with two decimal places", () => {
    expect(Money.from({ amount: "25", currency: "USD" }).toString()).toBe("25.00");
    expect(Money.from({ amount: "25.5", currency: "USD" }).toString()).toBe("25.50");
  });

  it("rejects invalid amount formats", () => {
    const invalidAmounts = [
      "",
      "NaN",
      "Infinity",
      "1e3",
      "-25",
      "+25",
      " 25",
      "25 ",
      "25.000",
      ".25",
      "25.",
      "25\n",
    ];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: "USD" })).toThrow(InvalidMoneyError);
    }
  });

  it("rejects currencies that are not three uppercase letters", () => {
    for (const currency of ["usd", "US", "USDD", "US\n"]) {
      expect(() => Money.from({ amount: "1", currency })).toThrow(InvalidMoneyError);
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
  });

  it("throws when operating on different currencies", () => {
    const dollars = Money.from({ amount: "1.00", currency: "USD" });
    const euros = Money.from({ amount: "1.00", currency: "EUR" });

    expect(() => dollars.add(euros)).toThrow(CurrencyMismatchError);
    expect(() => dollars.subtract(euros)).toThrow(CurrencyMismatchError);
    expect(() => dollars.isLessThan(euros)).toThrow(CurrencyMismatchError);
    expect(dollars.equals(euros)).toBe(false);
  });

  it("allows subtraction to produce a negative value", () => {
    const result = Money.from({ amount: "5", currency: "USD" }).subtract(
      Money.from({ amount: "7", currency: "USD" }),
    );

    expect(result.toString()).toBe("-2.00");
    expect(result.isNegative()).toBe(true);
    expect(result.isPositive()).toBe(false);
  });

  it("adds amounts beyond the safe integer range exactly", () => {
    const result = Money.from({ amount: "90071992547409.99", currency: "USD" }).add(
      Money.from({ amount: "0.01", currency: "USD" }),
    );

    expect(result.toString()).toBe("90071992547410.00");
  });

  it("returns new immutable instances for arithmetic operations", () => {
    const original = Money.from({ amount: "25", currency: "USD" });
    const addResult = original.add(Money.from({ amount: "1", currency: "USD" }));
    const subtractResult = original.subtract(Money.from({ amount: "1", currency: "USD" }));
    const negateResult = original.negate();

    expect(addResult).not.toBe(original);
    expect(subtractResult).not.toBe(original);
    expect(negateResult).not.toBe(original);
    expect(original.toString()).toBe("25.00");
    expect(Object.isFrozen(original)).toBe(true);
    expect(Reflect.set(original, "currency", "EUR")).toBe(false);
    expect(original.currency).toBe("USD");
  });

  it("creates zero and cents-backed values", () => {
    expect(Money.zero("USD").isZero()).toBe(true);
    expect(Money.fromCents(1234n, "USD").toString()).toBe("12.34");
    expect(Money.fromCents(-1n, "USD").toString()).toBe("-0.01");
  });
});
