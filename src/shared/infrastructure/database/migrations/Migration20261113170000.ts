import { Migration } from "@mikro-orm/migrations";

export class Migration20261113170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox_messages
        ADD COLUMN locked_by TEXT,
        ADD COLUMN locked_until TIMESTAMPTZ,
        ADD COLUMN last_error TEXT;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox_messages
        DROP COLUMN last_error,
        DROP COLUMN locked_until,
        DROP COLUMN locked_by;
    `);
  }
}
