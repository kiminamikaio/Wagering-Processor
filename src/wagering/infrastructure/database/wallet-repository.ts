import { EntityManager } from "@mikro-orm/core";
import { WalletRepository } from "../../application/ports/wagering-unit-of-work";
import { moneyToCents } from "./money-mapper";
import { WalletConcurrencyError } from "./persistence-errors";
import { walletFromRow } from "./row-mappers";
import { executeRows, executeStatement } from "./sql";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdForUpdate(id: string) {
    const rows = await executeRows(
      this.em,
      `SELECT id, player_id, currency, balance_cents, version, created_at, updated_at
       FROM wallets
       WHERE id = ?
       FOR UPDATE`,
      [id],
    );

    return rows[0] === undefined ? undefined : walletFromRow(rows[0]);
  }

  async insert(wallet: Parameters<WalletRepository["insert"]>[0]): Promise<void> {
    await executeStatement(
      this.em,
      `INSERT INTO wallets (
        id, player_id, currency, balance_cents, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        moneyToCents(wallet.balance),
        wallet.version,
        wallet.createdAt.toISOString(),
        wallet.updatedAt.toISOString(),
      ],
    );
  }

  async save(
    wallet: Parameters<WalletRepository["save"]>[0],
    expectedVersion: number,
  ): Promise<void> {
    const affectedRows = await executeStatement(
      this.em,
      `UPDATE wallets
       SET balance_cents = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      [
        moneyToCents(wallet.balance),
        wallet.version,
        wallet.updatedAt.toISOString(),
        wallet.id,
        expectedVersion,
      ],
    );

    if (affectedRows === 0) {
      throw new WalletConcurrencyError(wallet.id, expectedVersion);
    }
  }
}
