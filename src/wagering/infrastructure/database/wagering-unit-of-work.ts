import { EntityManager } from "@mikro-orm/core";
import {
  WageringTx,
  WageringUnitOfWork,
} from "../../application/ports/wagering-unit-of-work";
import { MikroOrmLedgerRepository } from "./ledger-repository";
import { MikroOrmOutboxRepository } from "./outbox-repository";
import { MikroOrmWalletRepository } from "./wallet-repository";
import { MikroOrmWagerTransactionRepository } from "./wager-transaction-repository";

class MikroOrmWageringTx implements WageringTx {
  readonly wallets: MikroOrmWalletRepository;
  readonly transactions: MikroOrmWagerTransactionRepository;
  readonly ledger: MikroOrmLedgerRepository;
  readonly outbox: MikroOrmOutboxRepository;

  constructor(em: EntityManager) {
    this.wallets = new MikroOrmWalletRepository(em);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}

export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  run<T>(work: (tx: WageringTx) => Promise<T>): Promise<T> {
    return this.em
      .fork()
      .transactional((em) => work(new MikroOrmWageringTx(em)));
  }
}
