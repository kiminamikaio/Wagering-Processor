import { EntityManager } from "@mikro-orm/core";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { wagerTransactionFromRow, walletFromRow, walletLedgerEntryFromRow } from "./row-mappers";
import { executeRows, requiredString } from "./sql";
import { Money } from "../../../shared/domain/money";

export interface WalletReconciliation {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

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

  async reconcileWallet(id: string): Promise<WalletReconciliation | undefined> {
    return this.em.fork().transactional(async (em) => {
      const wallets = await executeRows(
        em,
        `SELECT id, currency, balance_cents::text AS balance_cents
         FROM wallets
         WHERE id = ?
         FOR SHARE`,
        [id],
      );
      const wallet = wallets[0];
      if (wallet === undefined) {
        return undefined;
      }

      const totals = await executeRows(
        em,
        `SELECT COALESCE(
                  SUM(
                    CASE direction
                      WHEN 'CREDIT' THEN amount_cents
                      ELSE -amount_cents
                    END
                  ),
                  0
                )::text AS calculated_cents,
                COUNT(*)::text AS checked_entries
         FROM wallet_ledger_entries
         WHERE wallet_id = ?`,
        [id],
      );
      const checkedEntries = BigInt(requiredString(totals[0]!, "checked_entries"));
      if (checkedEntries > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError("Ledger entry count exceeds the supported response range.");
      }
      const currency = requiredString(wallet, "currency").trim();
      return {
        storedBalance: Money.fromCents(
          BigInt(requiredString(wallet, "balance_cents")),
          currency,
        ),
        calculatedBalance: Money.fromCents(
          BigInt(requiredString(totals[0]!, "calculated_cents")),
          currency,
        ),
        checkedEntries: Number(checkedEntries),
      };
    });
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
