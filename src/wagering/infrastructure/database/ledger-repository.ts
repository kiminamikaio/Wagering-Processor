import { EntityManager } from "@mikro-orm/core";
import { LedgerRepository } from "../../application/ports/wagering-unit-of-work";
import { moneyToCents } from "./money-mapper";
import { executeStatement } from "./sql";

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: Parameters<LedgerRepository["insert"]>[0]): Promise<void> {
    await executeStatement(
      this.em,
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount_cents,
        balance_before_cents, balance_after_cents, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        moneyToCents(entry.money),
        moneyToCents(entry.balanceBefore),
        moneyToCents(entry.balanceAfter),
        entry.createdAt.toISOString(),
      ],
    );
  }
}
