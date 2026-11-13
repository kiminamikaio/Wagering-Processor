import { WagerTransactionKind } from "../domain/wager-transaction";

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found.`);
    this.name = "WalletNotFoundError";
  }
}

export class WagerTransactionNotFoundError extends Error {
  constructor() {
    super("Wager transaction was not found.");
    this.name = "WagerTransactionNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was used with a different payload.`);
    this.name = "IdempotencyConflictError";
  }
}

export class InboxMessageConflictError extends Error {
  constructor(consumerName: string, messageId: string) {
    super(`Inbox message ${consumerName}/${messageId} has a different payload.`);
    this.name = "InboxMessageConflictError";
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`A ${currency} wallet already exists for player ${playerId}.`);
    this.name = "WalletAlreadyExistsError";
  }
}

export class UnsupportedTransactionKindError extends Error {
  constructor(kind: WagerTransactionKind) {
    super(`Transaction kind ${kind} is not supported by this use case.`);
    this.name = "UnsupportedTransactionKindError";
  }
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") {
    return true;
  }

  return (
    typeof candidate.cause === "object" &&
    candidate.cause !== null &&
    "code" in candidate.cause &&
    candidate.cause.code === "23505"
  );
}
