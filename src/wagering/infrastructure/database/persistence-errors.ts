export class PersistenceMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceMappingError";
  }
}

export class WalletConcurrencyError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`Wallet ${walletId} changed from expected version ${expectedVersion}.`);
    this.name = "WalletConcurrencyError";
  }
}
