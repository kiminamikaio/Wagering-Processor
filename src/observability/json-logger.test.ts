import { describe, expect, it } from "bun:test";
import { runWithLogContext } from "./correlation-context";
import { JsonLogger } from "./json-logger";

describe("JsonLogger", () => {
  it("writes one safe JSON line with the active correlation fields", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));
    const unsafeFields = {
      correlationId: "correlation-123",
      messageId: "message-456",
      transactionId: "transaction-789",
      walletId: "wallet-123",
      providerId: "provider-123",
      amount: "999999.99",
      balance: "999999.99",
      payload: { amount: "999999.99" },
      authorization: "Bearer secret",
    };

    runWithLogContext({ correlationId: "correlation-123" }, () => {
      logger.event(
        "info",
        "Wager transaction processed.",
        unsafeFields,
        "SubmitWagerTransactionUseCase",
      );
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      level: "info",
      message: "Wager transaction processed.",
      context: "SubmitWagerTransactionUseCase",
      correlationId: "correlation-123",
      messageId: "message-456",
      transactionId: "transaction-789",
      walletId: "wallet-123",
      providerId: "provider-123",
    });
    expect(record.timestamp).toBeString();
    expect(lines[0]).not.toContain("999999.99");
    expect(lines[0]).not.toContain("Bearer secret");
    expect(lines[0]).not.toContain("payload");
  });
});
