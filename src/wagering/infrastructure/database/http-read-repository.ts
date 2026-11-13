import { EntityManager } from "@mikro-orm/core";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { wagerTransactionFromRow, walletFromRow, walletLedgerEntryFromRow } from "./row-mappers";
import { executeRows, requiredString } from "./sql";

export interface LedgerPage {
  entries: Array<{ entry: WalletLedgerEntry; seq: string }>;
  hasMore: boolean;
}

export class MikroOrmHttpReadRepository {
  constructor(private readonly em: EntityManager) {}

  async findWalletById(id: string): Promise<Wallet | undefined> {
    const rows = await executeRows(
      this.em.fork(),
      `SELECT id, player_id, currency, balance_cents, version, created_at, updated_at
       FROM wallets
       WHERE id = ?`,
      [id],
    );

    return rows[0] === undefined ? undefined : walletFromRow(rows[0]);
  }

  async findLedgerPage(
    walletId: string,
    beforeSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    const rows = await executeRows(
      this.em.fork(),
      `SELECT wallet_ledger_entries.*, wallet_ledger_entries.seq::text AS seq,
              wallets.currency
       FROM wallet_ledger_entries
       JOIN wallets ON wallets.id = wallet_ledger_entries.wallet_id
       WHERE wallet_ledger_entries.wallet_id = ?
         AND (?::bigint IS NULL OR wallet_ledger_entries.seq < ?::bigint)
       ORDER BY wallet_ledger_entries.seq DESC
       LIMIT ?`,
      [walletId, beforeSeq ?? null, beforeSeq ?? null, limit + 1],
    );

    return {
      entries: rows.slice(0, limit).map((row) => ({
        entry: walletLedgerEntryFromRow(row),
        seq: requiredString(row, "seq"),
      })),
      hasMore: rows.length > limit,
    };
  }

  async findWagerTransactionById(
    id: string,
  ): Promise<WagerTransaction | undefined> {
    const rows = await executeRows(
      this.em.fork(),
      "SELECT * FROM wager_transactions WHERE id = ?",
      [id],
    );

    return rows[0] === undefined ? undefined : wagerTransactionFromRow(rows[0]);
  }

  async findWagerTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const rows = await executeRows(
      this.em.fork(),
      `SELECT *
       FROM wager_transactions
       WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );

    return rows[0] === undefined ? undefined : wagerTransactionFromRow(rows[0]);
  }
}
