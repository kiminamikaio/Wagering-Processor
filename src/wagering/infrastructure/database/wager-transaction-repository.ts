import { EntityManager } from "@mikro-orm/core";
import { Money } from "../../../shared/domain/money";
import { WagerTransactionRepository } from "../../application/ports/wagering-unit-of-work";
import { WagerTransaction } from "../../domain/wager-transaction";
import { moneyFromCents, moneyToCents } from "./money-mapper";
import { PersistenceMappingError } from "./persistence-errors";
import { wagerTransactionFromRow } from "./row-mappers";
import { executeRows, executeStatement, requiredString } from "./sql";

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

    return {
      transaction: wagerTransactionFromRow(rows[0]),
      observedBalance: moneyFromCents(
        requiredString(rows[0], "observed_balance_cents"),
        requiredString(rows[0], "observed_balance_currency"),
      ),
    };
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
