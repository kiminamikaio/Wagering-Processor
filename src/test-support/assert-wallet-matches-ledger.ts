import { EntityManager } from "@mikro-orm/core";
import { expect } from "bun:test";
import { executeRows, requiredString } from "../wagering/infrastructure/database/sql";

export async function assertWalletMatchesLedger(
  em: EntityManager,
  walletId: string,
): Promise<void> {
  const wallets = await executeRows(
    em.fork(),
    `SELECT balance_cents::text AS balance_cents, version::text AS version
     FROM wallets
     WHERE id = ?`,
    [walletId],
  );
  expect(wallets).toHaveLength(1);

  const entries = await executeRows(
    em.fork(),
    `SELECT wallet_ledger_entries.direction,
            wager_transactions.kind AS transaction_kind,
            wallet_ledger_entries.amount_cents::text AS amount_cents,
            balance_before_cents::text AS balance_before_cents,
            balance_after_cents::text AS balance_after_cents
     FROM wallet_ledger_entries
     JOIN wager_transactions
       ON wager_transactions.id = wallet_ledger_entries.transaction_id
     WHERE wallet_ledger_entries.wallet_id = ?
     ORDER BY wallet_ledger_entries.seq`,
    [walletId],
  );
  let previousBalance = 0n;
  let ledgerBalance = 0n;
  let versionedEntryCount = 0;

  for (const entry of entries) {
    const balanceBefore = BigInt(requiredString(entry, "balance_before_cents"));
    const balanceAfter = BigInt(requiredString(entry, "balance_after_cents"));
    const amount = BigInt(requiredString(entry, "amount_cents"));
    const expectedAfter =
      entry.direction === "CREDIT"
        ? balanceBefore + amount
        : balanceBefore - amount;

    expect(balanceBefore).toBe(previousBalance);
    expect(balanceAfter).toBe(expectedAfter);
    expect(balanceAfter).toBeGreaterThanOrEqual(0n);
    previousBalance = balanceAfter;
    ledgerBalance += entry.direction === "CREDIT" ? amount : -amount;
    if (entry.transaction_kind !== "OPENING") {
      versionedEntryCount += 1;
    }
  }

  expect(BigInt(requiredString(wallets[0]!, "balance_cents"))).toBe(ledgerBalance);
  expect(Number(requiredString(wallets[0]!, "version"))).toBe(versionedEntryCount + 1);
}
