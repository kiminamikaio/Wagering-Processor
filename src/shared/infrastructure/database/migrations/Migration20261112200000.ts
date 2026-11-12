import { Migration } from "@mikro-orm/migrations";

export class Migration20261112200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN observed_balance_cents BIGINT;

      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_observed_balance_non_negative
          CHECK (observed_balance_cents IS NULL OR observed_balance_cents >= 0),
        ADD CONSTRAINT wager_transactions_observed_balance_required
          CHECK (
            status NOT IN ('PROCESSED', 'REJECTED')
            OR observed_balance_cents IS NOT NULL
          );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP COLUMN observed_balance_cents;
    `);
  }
}
