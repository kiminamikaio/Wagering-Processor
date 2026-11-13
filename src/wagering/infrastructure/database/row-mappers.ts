import { Money } from "../../../shared/domain/money";
import { FailureCode } from "../../domain/errors";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/wallet-ledger-entry";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { moneyFromCents } from "./money-mapper";
import { PersistenceMappingError } from "./persistence-errors";
import {
  optionalDate,
  optionalString,
  requiredDate,
  requiredInteger,
  requiredString,
  SqlRow,
} from "./sql";

function enumValue<T extends string>(
  value: string,
  values: readonly T[],
  column: string,
): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new PersistenceMappingError(`Unexpected value in ${column}: ${value}.`);
  }

  return match;
}

function optionalFailureCode(row: SqlRow): FailureCode | undefined {
  const value = optionalString(row, "failure_code");
  return value === undefined
    ? undefined
    : enumValue(value, Object.values(FailureCode), "failure_code");
}

export function walletFromRow(row: SqlRow): Wallet {
  const currency = requiredString(row, "currency");

  return Wallet.rehydrate({
    id: requiredString(row, "id"),
    playerId: requiredString(row, "player_id"),
    currency,
    balance: moneyFromCents(requiredString(row, "balance_cents"), currency),
    version: requiredInteger(row, "version"),
    createdAt: requiredDate(row, "created_at"),
    updatedAt: requiredDate(row, "updated_at"),
  });
}

export function wagerTransactionFromRow(row: SqlRow): WagerTransaction {
  const currency = requiredString(row, "currency");
  const kind = enumValue(
    requiredString(row, "kind"),
    Object.values(WagerTransactionKind),
    "kind",
  );
  const status = enumValue(
    requiredString(row, "status"),
    Object.values(WagerTransactionStatus),
    "status",
  );
  const referenceTransactionId = optionalString(row, "reference_transaction_id");
  const referenceExternalTransactionId = optionalString(
    row,
    "reference_external_transaction_id",
  );
  const failureCode = optionalFailureCode(row);
  const processedAt = optionalDate(row, "processed_at");

  return WagerTransaction.rehydrate({
    id: requiredString(row, "id"),
    providerId: requiredString(row, "provider_id"),
    externalTransactionId: requiredString(row, "external_transaction_id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    payloadHash: requiredString(row, "payload_hash"),
    walletId: requiredString(row, "wallet_id"),
    playerId: requiredString(row, "player_id"),
    roundId: requiredString(row, "round_id"),
    gameId: requiredString(row, "game_id"),
    kind,
    money: moneyFromCents(requiredString(row, "amount_cents"), currency),
    referenceExternalTransactionId,
    createdAt: requiredDate(row, "created_at"),
    status,
    referenceTransactionId,
    referenceAttempts: requiredInteger(row, "reference_attempts"),
    referenceNextAttemptAt: optionalDate(row, "reference_next_attempt_at"),
    failureCode,
    processedAt,
  });
}

export function walletLedgerEntryFromRow(row: SqlRow): WalletLedgerEntry {
  const currency = requiredString(row, "currency");
  const direction = enumValue(
    requiredString(row, "direction"),
    Object.values(LedgerDirection),
    "direction",
  );

  return WalletLedgerEntry.rehydrate({
    id: requiredString(row, "id"),
    walletId: requiredString(row, "wallet_id"),
    transactionId: requiredString(row, "transaction_id"),
    direction,
    money: moneyFromCents(requiredString(row, "amount_cents"), currency),
    balanceBefore: moneyFromCents(
      requiredString(row, "balance_before_cents"),
      currency,
    ),
    balanceAfter: moneyFromCents(
      requiredString(row, "balance_after_cents"),
      currency,
    ),
    createdAt: requiredDate(row, "created_at"),
  });
}
