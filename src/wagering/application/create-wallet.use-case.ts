import { Money } from "../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { computePayloadHash } from "./compute-payload-hash";
import { WalletAlreadyExistsError, isPostgresUniqueViolation } from "./errors";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
  enqueueIntegrationEvent,
} from "./events/integration-events";
import {
  Clock,
  IdGenerator,
  WageringUnitOfWork,
} from "./ports/wagering-unit-of-work";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    const at = this.clock.now();
    const wallet = Wallet.open({
      id: this.idGenerator.next(),
      playerId: input.playerId,
      initialBalance,
      at,
    });

    await this.unitOfWork.run(async (tx) => {
      try {
        await tx.wallets.insert(wallet);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          throw new WalletAlreadyExistsError(
            input.playerId,
            initialBalance.currency,
          );
        }
        throw error;
      }

      if (!initialBalance.isPositive()) {
        return;
      }

      const transactionId = this.idGenerator.next();
      const transaction = WagerTransaction.createOpening({
        id: transactionId,
        providerId: "internal",
        externalTransactionId: wallet.id,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: computePayloadHash({
          providerId: "internal",
          externalTransactionId: wallet.id,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "opening",
          gameId: "opening",
          kind: "OPENING",
          money: initialBalance.toJSON(),
        }),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "opening",
        gameId: "opening",
        money: initialBalance,
        createdAt: at,
      });
      await tx.transactions.insert(transaction);

      const entry = WalletLedgerEntry.create({
        id: this.idGenerator.next(),
        walletId: wallet.id,
        transactionId,
        direction: LedgerDirection.CREDIT,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        createdAt: at,
      });
      await tx.ledger.insert(entry);

      transaction.markProcessed(undefined, at);
      await tx.transactions.save(transaction, wallet.balance);

      const correlationId = transaction.id;
      await enqueueIntegrationEvent(
        tx,
        new WagerTransactionProcessed({
          eventId: this.idGenerator.next(),
          aggregateId: wallet.id,
          correlationId,
          occurredAt: at,
          data: {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            kind: transaction.kind,
            money: transaction.money.toJSON(),
            balance: wallet.balance.toJSON(),
          },
        }),
      );
      await enqueueIntegrationEvent(
        tx,
        new WalletBalanceChanged({
          eventId: this.idGenerator.next(),
          aggregateId: wallet.id,
          correlationId,
          occurredAt: at,
          data: {
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        }),
      );
    });

    return wallet;
  }
}
