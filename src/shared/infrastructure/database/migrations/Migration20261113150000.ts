import { Migration } from "@mikro-orm/migrations";

export class Migration20261113150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallet_ledger_entries
        ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;

      CREATE UNIQUE INDEX wallet_ledger_entries_seq_unique
        ON wallet_ledger_entries (seq);

      DROP INDEX wallet_ledger_entries_wallet_id_id_idx;
      CREATE INDEX wallet_ledger_entries_wallet_id_seq_idx
        ON wallet_ledger_entries (wallet_id, seq DESC);
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP INDEX wallet_ledger_entries_wallet_id_seq_idx;
      DROP INDEX wallet_ledger_entries_seq_unique;
      ALTER TABLE wallet_ledger_entries DROP COLUMN seq;
      CREATE INDEX wallet_ledger_entries_wallet_id_id_idx
        ON wallet_ledger_entries (wallet_id, id);
    `);
  }
}
