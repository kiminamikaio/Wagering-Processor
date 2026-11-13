import { WagerTransaction } from "../domain/wager-transaction";
import { WageringTx } from "./ports/wagering-unit-of-work";

export class WagerTransactionReferenceResolver {
  resolve(
    tx: WageringTx,
    providerId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return tx.transactions.findReferenceForUpdate(
      providerId,
      referenceExternalTransactionId,
    );
  }
}
