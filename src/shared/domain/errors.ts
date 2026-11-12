export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(`Cannot operate on different currencies: ${leftCurrency} and ${rightCurrency}.`);
    this.name = "CurrencyMismatchError";
  }
}
