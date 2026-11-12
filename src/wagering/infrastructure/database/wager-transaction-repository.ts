import { EntityManager } from "@mikro-orm/core";
import { Money } from "../../../shared/domain/money";
import { WagerTransactionRepository } from "../../application/ports/wagering-unit-of-work";
import { CurrencyMismatchError } from "../../domain/errors";
import { WagerTransaction } from "../../domain/wager-transaction";
import { moneyToCents } from "./money-mapper";
import { PersistenceMappingError } from "./persistence-errors";
import { wagerTransactionFromRow } from "./row-mappers";
import { executeRows, executeStatement } from "./sql";

export class MikroOrmWagerTransactionRepository
  implements WagerTransactionRepository
{
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKeyOrExternalId(
    providerId: string,
    externalTransactionId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const rows = await executeRows(
      this.em,
      `SELECT id, wallet_id, player_id, round_id, game_id, provider_id,
              external_transaction_id, idempotency_key, payload_hash, kind,
              status, amount_cents, currency, reference_transaction_id,
              reference_external_transaction_id, failure_code, created_at, processed_at
       FROM wager_transactions
       WHERE idempotency_key = ?
          OR (provider_id = ? AND external_transaction_id = ?)
       LIMIT 2`,
      [idempotencyKey, providerId, externalTransactionId],
    );

    if (rows.length > 1) {
      throw new PersistenceMappingError(
        "The idempotency key and external identifier matched different wager transactions.",
      );
    }

    return rows[0] === undefined ? undefined : wagerTransactionFromRow(rows[0]);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await executeStatement(
      this.em,
      `INSERT INTO wager_transactions (
        id, wallet_id, player_id, round_id, game_id, provider_id,
        external_transaction_id, idempotency_key, payload_hash, kind, status,
        amount_cents, currency, reference_transaction_id,
        reference_external_transaction_id, failure_code, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        transaction.createdAt.toISOString(),
        transaction.processedAt?.toISOString() ?? null,
      ],
    );
  }

  async save(transaction: WagerTransaction, observedBalance: Money): Promise<void> {
    if (transaction.money.currency !== observedBalance.currency) {
      throw new CurrencyMismatchError(
        transaction.money.currency,
        observedBalance.currency,
      );
    }

    await executeStatement(
      this.em,
      `UPDATE wager_transactions
       SET status = ?, failure_code = ?, processed_at = ?,
           reference_transaction_id = ?, observed_balance_cents = ?
       WHERE id = ?`,
      [
        transaction.status,
        transaction.failureCode ?? null,
        transaction.processedAt?.toISOString() ?? null,
        transaction.referenceTransactionId ?? null,
        moneyToCents(observedBalance),
        transaction.id,
      ],
    );
  }
}
