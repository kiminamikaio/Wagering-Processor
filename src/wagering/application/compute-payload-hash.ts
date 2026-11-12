import { createHash } from "node:crypto";
import { MoneyInput } from "../../shared/domain/money";

export interface WagerPayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyInput;
  referenceExternalTransactionId?: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function computePayloadHash(input: WagerPayloadHashInput): string {
  const businessPayload = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: input.money.amount,
      currency: input.money.currency,
    },
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
  const canonicalJson = JSON.stringify(canonicalize(businessPayload));

  if (canonicalJson === undefined) {
    throw new Error("The wager payload could not be serialized as canonical JSON.");
  }

  return createHash("sha256").update(canonicalJson).digest("hex");
}
