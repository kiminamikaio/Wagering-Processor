import { describe, expect, it } from "bun:test";
import { Money } from "../../shared/domain/money";
import {
  FailureCode,
  InvalidReferenceKindError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  MissingReferenceError,
} from "./errors";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";
import { LedgerDirection } from "./wallet-ledger-entry";

const createdAt = new Date("2026-02-01T00:00:00.000Z");
const processedAt = new Date("2026-02-02T00:00:00.000Z");

function props(
  kind = WagerTransactionKind.BET,
): Parameters<typeof WagerTransaction.create>[0] {
  return {
    id: "transaction-1",
    providerId: "provider/free-form",
    externalTransactionId: "external:transaction/1",
    idempotencyKey: "provider:request:1",
    payloadHash: "payload-hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round/free-form",
    gameId: "game/free-form",
    kind,
    money: Money.from({ amount: "12.34", currency: "BRL" }),
    referenceExternalTransactionId:
      kind === WagerTransactionKind.REFUND || kind === WagerTransactionKind.ROLLBACK
        ? "external:reference/1"
        : undefined,
    createdAt,
  };
}

function createTransaction(kind = WagerTransactionKind.BET): WagerTransaction {
  return WagerTransaction.create(props(kind));
}

describe("WagerTransaction", () => {
  it("creates PENDING transactions with free-form provider identifiers", () => {
    const transaction = createTransaction();

    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.providerId).toBe("provider/free-form");
    expect(transaction.externalTransactionId).toBe("external:transaction/1");
    expect(transaction.roundId).toBe("round/free-form");
    expect(transaction.gameId).toBe("game/free-form");
  });

  it("validates the required external reference and keeps OPENING internal", () => {
    for (const kind of [WagerTransactionKind.REFUND, WagerTransactionKind.ROLLBACK]) {
      expect(() =>
        WagerTransaction.create({
          ...props(kind),
          referenceExternalTransactionId: undefined,
        }),
      ).toThrow(InvalidWagerTransactionError);
    }

    expect(() =>
      WagerTransaction.create(props(WagerTransactionKind.OPENING)),
    ).toThrow(InvalidWagerTransactionError);

    const opening = WagerTransaction.createOpening({
      ...props(WagerTransactionKind.BET),
    });
    expect(opening.kind).toBe(WagerTransactionKind.OPENING);
    expect(opening.status).toBe(WagerTransactionStatus.PENDING);
  });

  it("allows all transitions from PENDING", () => {
    const transitions: Array<{
      status: WagerTransactionStatus;
      apply: (transaction: WagerTransaction) => void;
    }> = [
      {
        status: WagerTransactionStatus.PROCESSED,
        apply: (transaction) => transaction.markProcessed("internal-reference", processedAt),
      },
      {
        status: WagerTransactionStatus.PENDING_REFERENCE,
        apply: (transaction) => transaction.markPendingReference(),
      },
      {
        status: WagerTransactionStatus.REJECTED,
        apply: (transaction) => transaction.reject(FailureCode.INSUFFICIENT_FUNDS),
      },
      {
        status: WagerTransactionStatus.FAILED,
        apply: (transaction) => transaction.fail(FailureCode.REFERENCE_NOT_FOUND),
      },
    ];

    for (const transition of transitions) {
      const transaction = createTransaction();
      transition.apply(transaction);
      expect(transaction.status).toBe(transition.status);
    }
  });

  it("allows only terminal transitions from PENDING_REFERENCE", () => {
    const transitions: Array<{
      status: WagerTransactionStatus;
      apply: (transaction: WagerTransaction) => void;
    }> = [
      {
        status: WagerTransactionStatus.PROCESSED,
        apply: (transaction) => transaction.markProcessed(undefined, processedAt),
      },
      {
        status: WagerTransactionStatus.REJECTED,
        apply: (transaction) => transaction.reject(FailureCode.REFERENCE_MISMATCH),
      },
      {
        status: WagerTransactionStatus.FAILED,
        apply: (transaction) => transaction.fail(FailureCode.REFERENCE_NOT_FOUND),
      },
    ];

    for (const transition of transitions) {
      const transaction = createTransaction();
      transaction.markPendingReference();
      transition.apply(transaction);
      expect(transaction.status).toBe(transition.status);
    }

    const stillPendingReference = createTransaction();
    stillPendingReference.markPendingReference();
    expect(() => stillPendingReference.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("rejects every transition from terminal states", () => {
    const terminalStates: Array<(transaction: WagerTransaction) => void> = [
      (transaction) => transaction.markProcessed(undefined, processedAt),
      (transaction) => transaction.reject(FailureCode.AMOUNT_MISMATCH),
      (transaction) => transaction.fail(FailureCode.REFERENCE_NOT_FOUND),
    ];
    const transitions: Array<(transaction: WagerTransaction) => void> = [
      (transaction) => transaction.markProcessed(undefined, processedAt),
      (transaction) => transaction.markPendingReference(),
      (transaction) => transaction.reject(FailureCode.INSUFFICIENT_FUNDS),
      (transaction) => transaction.fail(FailureCode.REFERENCE_NOT_FOUND),
    ];

    for (const makeTerminal of terminalStates) {
      for (const transition of transitions) {
        const transaction = createTransaction();
        makeTerminal(transaction);
        expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
        expect(transaction.isTerminal()).toBe(true);
      }
    }
  });

  it("records the processing reference and supplied time", () => {
    const transaction = createTransaction();
    transaction.markProcessed("internal-reference", processedAt);

    expect(transaction.referenceTransactionId).toBe("internal-reference");
    expect(transaction.processedAt).toEqual(processedAt);
    expect(transaction.isTerminal()).toBe(true);
  });

  it("records failure codes and matches payload hashes", () => {
    const transaction = createTransaction();
    expect(transaction.matchesPayload("payload-hash-1")).toBe(true);
    expect(transaction.matchesPayload("different-hash")).toBe(false);

    transaction.reject(FailureCode.INSUFFICIENT_FUNDS);
    expect(transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(transaction.isTerminal()).toBe(true);

    const failed = createTransaction();
    failed.fail(FailureCode.REFERENCE_NOT_FOUND);
    expect(failed.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(failed.isTerminal()).toBe(true);
  });

  it("rehydrates persisted states without revalidating their transition history", () => {
    const transaction = WagerTransaction.rehydrate({
      ...props(),
      status: WagerTransactionStatus.PROCESSED,
      failureCode: FailureCode.AMOUNT_MISMATCH,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.failureCode).toBe(FailureCode.AMOUNT_MISMATCH);
    expect(transaction.processedAt).toBeUndefined();
    expect(() => transaction.reject(FailureCode.CURRENCY_MISMATCH)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("maps every kind to its ledger effect", () => {
    const opening = WagerTransaction.createOpening({
      ...props(WagerTransactionKind.BET),
    });
    const bet = createTransaction(WagerTransactionKind.BET);
    const win = createTransaction(WagerTransactionKind.WIN);
    const loss = createTransaction(WagerTransactionKind.LOSS);
    const refund = createTransaction(WagerTransactionKind.REFUND);
    const rollback = createTransaction(WagerTransactionKind.ROLLBACK);

    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.DEBIT);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.CREDIT);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(loss.affectsBalance()).toBe(false);
    expect(bet.affectsBalance()).toBe(true);
    expect(refund.requiresReference()).toBe(true);
    expect(rollback.requiresReference()).toBe(true);
    expect(bet.requiresReference()).toBe(false);

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.CREDIT);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.DEBIT);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.DEBIT);
  });

  it("requires a valid reference to determine a rollback direction", () => {
    const rollback = createTransaction(WagerTransactionKind.ROLLBACK);
    const loss = createTransaction(WagerTransactionKind.LOSS);

    expect(() => rollback.ledgerDirectionFor()).toThrow(MissingReferenceError);
    expect(() => rollback.ledgerDirectionFor(loss)).toThrow(InvalidReferenceKindError);
  });

  it("exposes stable machine-readable failure codes", () => {
    expect(Object.values(FailureCode).map(String)).toEqual([
      "INSUFFICIENT_FUNDS",
      "REVERSAL_WOULD_OVERDRAW",
      "REFERENCE_NOT_FOUND",
      "REFERENCE_MISMATCH",
      "INVALID_REFERENCE_KIND",
      "AMOUNT_MISMATCH",
      "ALREADY_REVERSED",
      "CURRENCY_MISMATCH",
    ]);
  });
});
