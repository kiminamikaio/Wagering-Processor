import { EntityManager } from "@mikro-orm/core";
import { Money } from "../../../shared/domain/money";
import { WagerTransactionRepository } from "../../application/ports/wagering-unit-of-work";
import { WagerTransaction } from "../../domain/wager-transaction";
import { moneyFromCents, moneyToCents } from "./money-mapper";
import { PersistenceMappingError } from "./persistence-errors";
import { wagerTransactionFromRow } from "./row-mappers";
import {
  executeRows,
  executeStatement,
  optionalString,
  requiredString,
} from "./sql";

export class MikroOrmWagerTransactionRepository
  implements WagerTransactionRepository
{
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKeyOrExternalId(
    providerId: string,
    externalTransactionId: string,
    idempotencyKey: string,
  ) {
    const rows = await executeRows(
      this.em,
      `SELECT wager_transactions.*,
              wallets.currency AS observed_balance_currency
       FROM wager_transactions
       JOIN wallets ON wallets.id = wager_transactions.wallet_id
       WHERE wager_transactions.idempotency_key = ?
          OR (
            wager_transactions.provider_id = ?
            AND wager_transactions.external_transaction_id = ?
          )
       LIMIT 2`,
      [idempotencyKey, providerId, externalTransactionId],
    );

    if (rows.length > 1) {
      throw new PersistenceMappingError(
        "The idempotency key and external identifier matched different wager transactions.",
      );
    }

    if (rows[0] === undefined) {
      return undefined;
    }

    const observedBalanceCents = optionalString(
      rows[0],
      "observed_balance_cents",
    );

    return {
      transaction: wagerTransactionFromRow(rows[0]),
      observedBalance:
        observedBalanceCents === undefined
          ? undefined
          : moneyFromCents(
              observedBalanceCents,
              requiredString(rows[0], "observed_balance_currency"),
            ),
    };
  }

  async findDueReferenceIds(now: Date, limit: number, providerId?: string) {
    const providerFilter =
      providerId === undefined ? "" : "AND provider_id = ?";
    const params =
      providerId === undefined ? [now, limit] : [now, providerId, limit];
    const rows = await executeRows(
      this.em,
      `SELECT id::text AS id, wallet_id::text AS wallet_id
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND reference_next_attempt_at <= ?
         ${providerFilter}
       ORDER BY reference_next_attempt_at, created_at, id
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      params,
    );

    return rows.map((row) => ({
      id: requiredString(row, "id"),
      walletId: requiredString(row, "wallet_id"),
    }));
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const rows = await executeRows(
      this.em,
      "SELECT * FROM wager_transactions WHERE id = ? FOR UPDATE",
      [id],
    );

    return rows[0] === undefined ? undefined : wagerTransactionFromRow(rows[0]);
  }

  async findReferenceForUpdate(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const rows = await executeRows(
      this.em,
      `SELECT *
       FROM wager_transactions
       WHERE provider_id = ? AND external_transaction_id = ?
       FOR UPDATE`,
      [providerId, externalTransactionId],
    );

    return rows[0] === undefined
      ? undefined
      : wagerTransactionFromRow(rows[0]);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await executeRows(
      this.em,
      `SELECT id
       FROM wager_transactions
       WHERE reference_transaction_id = ?
         AND status = 'PROCESSED'
         AND kind IN ('REFUND', 'ROLLBACK')
       LIMIT 1`,
      [referenceTransactionId],
    );

    return rows.length > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await executeStatement(
      this.em,
      `INSERT INTO wager_transactions (
        id, wallet_id, player_id, round_id, game_id, provider_id,
        external_transaction_id, idempotency_key, payload_hash, kind, status,
        amount_cents, currency, reference_transaction_id,
        reference_external_transaction_id, failure_code, reference_attempts,
        reference_next_attempt_at, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transaction.id,
        transaction.walletId,
        transaction.playerId,
        transaction.roundId,
        transaction.gameId,
        transaction.providerId,
        transaction.externalTransactionId,
        transaction.idempotencyKey,
        transaction.payloadHash,
        transaction.kind,
        transaction.status,
        moneyToCents(transaction.money),
        transaction.money.currency,
        transaction.referenceTransactionId ?? null,
        transaction.referenceExternalTransactionId ?? null,
        transaction.failureCode ?? null,
        transaction.referenceAttempts,
        transaction.referenceNextAttemptAt?.toISOString() ?? null,
        transaction.createdAt.toISOString(),
        transaction.processedAt?.toISOString() ?? null,
      ],
    );
  }

  async save(
    transaction: WagerTransaction,
    observedBalance: Money | undefined,
  ): Promise<void> {
    await executeStatement(
      this.em,
      `UPDATE wager_transactions
       SET status = ?, failure_code = ?, processed_at = ?,
           reference_transaction_id = ?, observed_balance_cents = ?,
           reference_attempts = ?, reference_next_attempt_at = ?
       WHERE id = ?`,
      [
        transaction.status,
        transaction.failureCode ?? null,
        transaction.processedAt?.toISOString() ?? null,
        transaction.referenceTransactionId ?? null,
        observedBalance === undefined ? null : moneyToCents(observedBalance),
        transaction.referenceAttempts,
        transaction.referenceNextAttemptAt?.toISOString() ?? null,
        transaction.id,
      ],
    );
  }
}
