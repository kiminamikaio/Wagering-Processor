import { Money } from "../../../shared/domain/money";
import { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import { WagerTransaction } from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";

export interface WageringUnitOfWork {
  run<T>(work: (tx: WageringTx) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface WageringTx {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface ExistingWagerTransaction {
  transaction: WagerTransaction;
  observedBalance: Money | undefined;
}

export interface WalletRepository {
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findByIdempotencyKeyOrExternalId(
    providerId: string,
    externalTransactionId: string,
    idempotencyKey: string,
  ): Promise<ExistingWagerTransaction | undefined>;
  findReferenceForUpdate(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  save(
    transaction: WagerTransaction,
    observedBalance: Money | undefined,
  ): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface EnqueueOutboxMessage {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface OutboxRepository {
  enqueue(message: EnqueueOutboxMessage): Promise<void>;
}

export interface InboxMessageInput {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface InboxRepository {
  insertIfAbsent(message: InboxMessageInput): Promise<boolean>;
  markProcessed(consumerName: string, messageId: string): Promise<void>;
}
