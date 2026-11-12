import { Migration } from "@mikro-orm/migrations";

export class Migration20261112180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_cents BIGINT NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance_cents >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1)
      );

      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id UUID NOT NULL,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_transaction_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        CONSTRAINT wager_transactions_wallet_id_foreign
          FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wager_transactions_reference_transaction_id_foreign
          FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),
        CONSTRAINT wager_transactions_provider_external_transaction_unique
          UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_transactions_amount_positive CHECK (amount_cents > 0),
        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
      );

      CREATE UNIQUE INDEX wager_transactions_processed_reference_kind_unique
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');

      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        balance_before_cents BIGINT NOT NULL,
        balance_after_cents BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT wallet_ledger_entries_wallet_id_foreign
          FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wallet_ledger_entries_transaction_id_foreign
          FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id),
        CONSTRAINT wallet_ledger_entries_wallet_transaction_unique UNIQUE (wallet_id, transaction_id),
        CONSTRAINT wallet_ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_amount_positive CHECK (amount_cents > 0),
        CONSTRAINT wallet_ledger_entries_balance_arithmetic CHECK (
          direction NOT IN ('DEBIT', 'CREDIT')
          OR
          (direction = 'CREDIT' AND balance_after_cents = balance_before_cents + amount_cents)
          OR
          (direction = 'DEBIT' AND balance_after_cents = balance_before_cents - amount_cents)
        ),
        CONSTRAINT wallet_ledger_entries_balance_after_non_negative CHECK (balance_after_cents >= 0)
      );

      CREATE FUNCTION prevent_wallet_ledger_entries_mutation() RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'wallet_ledger_entries is append-only'
            USING ERRCODE = '55000';
        END;
        $$;

      CREATE TRIGGER wallet_ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_wallet_ledger_entries_mutation();

      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id UUID NOT NULL,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ,
        CONSTRAINT inbox_messages_pkey PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT outbox_messages_attempt_count_non_negative CHECK (attempt_count >= 0)
      );

      CREATE INDEX outbox_messages_unpublished_next_attempt_at_idx
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
      DROP FUNCTION IF EXISTS prevent_wallet_ledger_entries_mutation();
    `);
  }
}
