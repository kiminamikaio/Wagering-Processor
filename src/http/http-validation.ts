import { BadRequestException } from "@nestjs/common";
import { MoneyProps } from "../wagering/application/events/integration-events";
import { SubmitWagerTransactionInput } from "../wagering/application/submit-wager-transaction.use-case";
import { CreateWalletInput } from "../wagering/application/create-wallet.use-case";
import { WagerTransactionKind } from "../wagering/domain/wager-transaction";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${name} must be an object.`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${name} must be a non-empty string.`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new BadRequestException(`${name} must be a UUID.`);
  }
  return result;
}

function money(value: unknown, name: string): MoneyProps {
  const input = objectValue(value, name);
  if (typeof input.amount !== "string") {
    throw new BadRequestException(`${name}.amount must be a decimal string.`);
  }
  const amount = input.amount;
  if (!/^\d+\.\d{2}$/.test(amount)) {
    throw new BadRequestException(`${name}.amount must use two decimal places.`);
  }
  return {
    amount,
    currency: requiredString(input.currency, `${name}.currency`),
  };
}

export function parseCreateWalletInput(value: unknown): CreateWalletInput {
  const input = objectValue(value, "body");
  return {
    playerId: uuid(input.playerId, "playerId"),
    initialBalance: money(input.initialBalance, "initialBalance"),
  };
}

export function parseSubmitWagerInput(
  value: unknown,
  idempotencyKey: string | undefined,
): SubmitWagerTransactionInput {
  if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
    throw new BadRequestException("Idempotency-Key header is required.");
  }

  const input = objectValue(value, "body");
  const kind = requiredString(input.kind, "kind");
  if (!Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind)) {
    throw new BadRequestException("kind is not supported.");
  }

  return {
    providerId: requiredString(input.providerId, "providerId"),
    externalTransactionId: requiredString(
      input.externalTransactionId,
      "externalTransactionId",
    ),
    idempotencyKey,
    playerId: uuid(input.playerId, "playerId"),
    walletId: uuid(input.walletId, "walletId"),
    roundId: requiredString(input.roundId, "roundId"),
    gameId: requiredString(input.gameId, "gameId"),
    kind: kind as WagerTransactionKind,
    money: money(input.money, "money"),
    ...(input.referenceExternalTransactionId === undefined
      ? {}
      : {
          referenceExternalTransactionId: requiredString(
            input.referenceExternalTransactionId,
            "referenceExternalTransactionId",
          ),
        }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: requiredString(input.correlationId, "correlationId") }),
  };
}

export function parseWalletId(value: string): string {
  return uuid(value, "walletId");
}

export function parseTransactionId(value: string): string {
  return uuid(value, "transactionId");
}

export function parseLedgerLimit(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 50;
  }
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException("limit must be an integer from 1 to 100.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new BadRequestException("limit must be an integer from 1 to 100.");
  }
  return limit;
}

export function decodeLedgerCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new BadRequestException("cursor is invalid.");
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (!/^[1-9]\d*$/.test(decoded) || Buffer.from(decoded).toString("base64") !== value) {
    throw new BadRequestException("cursor is invalid.");
  }
  return decoded;
}

export function encodeLedgerCursor(seq: string): string {
  return Buffer.from(seq).toString("base64");
}
