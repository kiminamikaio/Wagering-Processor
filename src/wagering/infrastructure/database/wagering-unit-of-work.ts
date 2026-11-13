import { EntityManager } from "@mikro-orm/core";
import {
  WageringTx,
  WageringUnitOfWork,
} from "../../application/ports/wagering-unit-of-work";
import { MikroOrmLedgerRepository } from "./ledger-repository";
import { MikroOrmOutboxRepository } from "./outbox-repository";
import { MikroOrmWalletRepository } from "./wallet-repository";
import { MikroOrmWagerTransactionRepository } from "./wager-transaction-repository";
import { MikroOrmInboxRepository } from "./inbox-repository";

function lockTimeoutMilliseconds(): number {
  const rawValue = process.env.DB_LOCK_TIMEOUT_MS;
  if (rawValue === undefined) {
    return 5_000;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("DB_LOCK_TIMEOUT_MS must be a positive integer.");
  }

  return value;
}

class MikroOrmWageringTx implements WageringTx {
  readonly wallets: MikroOrmWalletRepository;
  readonly transactions: MikroOrmWagerTransactionRepository;
  readonly ledger: MikroOrmLedgerRepository;
  readonly outbox: MikroOrmOutboxRepository;
  readonly inbox: MikroOrmInboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
  }
}

export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  run<T>(work: (tx: WageringTx) => Promise<T>): Promise<T> {
    return this.em
      .fork()
      .transactional(async (em) => {
        await em
          .getConnection()
          .execute(
            "SELECT set_config('lock_timeout', ?, true)",
            [`${lockTimeoutMilliseconds()}ms`],
            "run",
            em.getTransactionContext(),
          );
        return work(new MikroOrmWageringTx(em));
      });
  }
}
