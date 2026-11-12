import { expect, it } from "bun:test";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { UnsupportedTransactionKindError } from "./errors";
import { SubmitWagerTransactionUseCase } from "./submit-wager-transaction.use-case";
import { Clock, IdGenerator, WageringUnitOfWork } from "./ports/wagering-unit-of-work";

it("rejects unsupported kinds before opening a unit-of-work transaction", async () => {
  let openedTransactions = 0;
  const unitOfWork: WageringUnitOfWork = {
    run: async () => {
      openedTransactions += 1;
      throw new Error("A transaction must not be opened.");
    },
  };
  const clock: Clock = { now: () => new Date(0) };
  const ids: IdGenerator = { next: () => "unused" };
  const useCase = new SubmitWagerTransactionUseCase(unitOfWork, clock, ids);

  for (const kind of [
    WagerTransactionKind.REFUND,
    WagerTransactionKind.ROLLBACK,
    WagerTransactionKind.OPENING,
  ]) {
    await expect(
      useCase.execute({
        providerId: "provider",
        externalTransactionId: "external",
        idempotencyKey: "key",
        playerId: "player",
        walletId: "wallet",
        roundId: "round",
        gameId: "game",
        kind,
        money: { amount: "1.00", currency: "BRL" },
      }),
    ).rejects.toThrow(UnsupportedTransactionKindError);
  }

  expect(openedTransactions).toBe(0);
});
