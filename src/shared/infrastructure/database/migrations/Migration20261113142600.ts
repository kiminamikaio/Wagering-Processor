import { Migration } from "@mikro-orm/migrations";

export class Migration20261113142600 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      DROP INDEX wager_transactions_processed_reference_kind_unique;

      CREATE UNIQUE INDEX wager_transactions_processed_reference_unique
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP INDEX wager_transactions_processed_reference_unique;

      CREATE UNIQUE INDEX wager_transactions_processed_reference_kind_unique
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);
  }
}
