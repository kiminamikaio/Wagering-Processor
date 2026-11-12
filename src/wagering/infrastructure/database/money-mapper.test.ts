import { describe, expect, it } from "bun:test";
import { Money } from "../../../shared/domain/money";
import { moneyFromCents, moneyToCents } from "./money-mapper";

describe("Money database mapping", () => {
  it("round-trips decimal amounts exactly through integer cents", () => {
    for (const amount of ["0.10", "0.01", "90071992547409.99"]) {
      const money = Money.from({ amount, currency: "BRL" });
      const cents = moneyToCents(money);

      expect(moneyFromCents(cents, money.currency).toString()).toBe(amount);
    }
  });
});
