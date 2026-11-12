import { expect, it } from "bun:test";
import { WagerTransactionKind } from "../../domain/wager-transaction";
import { WagerTransactionProcessed } from "./integration-events";

it("serializes integration events with an ISO timestamp and MoneyProps data", () => {
  const event = new WagerTransactionProcessed({
    eventId: "event-1",
    aggregateId: "wallet-1",
    correlationId: "correlation-1",
    occurredAt: new Date("2026-11-12T12:00:00.000Z"),
    data: {
      transactionId: "transaction-1",
      providerId: "provider-1",
      externalTransactionId: "external-1",
      playerId: "player-1",
      walletId: "wallet-1",
      kind: WagerTransactionKind.WIN,
      money: { amount: "1.25", currency: "BRL" },
      balance: { amount: "2.50", currency: "BRL" },
    },
  });

  expect(event.toJSON()).toEqual({
    eventId: "event-1",
    eventType: "WagerTransactionProcessed",
    aggregateId: "wallet-1",
    correlationId: "correlation-1",
    occurredAt: "2026-11-12T12:00:00.000Z",
    version: 1,
    data: {
      transactionId: "transaction-1",
      providerId: "provider-1",
      externalTransactionId: "external-1",
      playerId: "player-1",
      walletId: "wallet-1",
      kind: WagerTransactionKind.WIN,
      money: { amount: "1.25", currency: "BRL" },
      balance: { amount: "2.50", currency: "BRL" },
    },
  });
  expect(Object.isFrozen(event.data)).toBe(true);
});
