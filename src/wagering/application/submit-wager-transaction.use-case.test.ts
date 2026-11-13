import { expect, it } from "bun:test";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { UnsupportedTransactionKindError } from "./errors";
import { SubmitWagerTransactionUseCase } from "./submit-wager-transaction.use-case";
import { Clock, IdGenerator, WageringUnitOfWork } from "./ports/wagering-unit-of-work";

it("rejects OPENING before opening a unit-of-work transaction", async () => {
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

  await expect(
    useCase.execute({
      providerId: "provider",
      externalTransactionId: "external",
      idempotencyKey: "key",
      playerId: "player",
      walletId: "wallet",
      roundId: "round",
      gameId: "game",
      kind: WagerTransactionKind.OPENING,
      money: { amount: "1.00", currency: "BRL" },
    }),
  ).rejects.toThrow(UnsupportedTransactionKindError);

  expect(openedTransactions).toBe(0);
});

it("opens a unit-of-work transaction for REFUND and ROLLBACK", async () => {
  let openedTransactions = 0;
  const unitOfWork: WageringUnitOfWork = {
    run: async () => {
      openedTransactions += 1;
      throw new Error("The use case reached the transaction.");
    },
  };
  const useCase = new SubmitWagerTransactionUseCase(
    unitOfWork,
    { now: () => new Date(0) },
    { next: () => "unused" },
  );

  for (const kind of [WagerTransactionKind.REFUND, WagerTransactionKind.ROLLBACK]) {
    await expect(
      useCase.execute({
        providerId: "provider",
        externalTransactionId: `external-${kind}`,
        idempotencyKey: `key-${kind}`,
        playerId: "player",
        walletId: "wallet",
        roundId: "round",
        gameId: "game",
        kind,
        money: { amount: "1.00", currency: "BRL" },
        referenceExternalTransactionId: "reference",
      }),
    ).rejects.toThrow("The use case reached the transaction.");
  }

  expect(openedTransactions).toBe(2);
});
