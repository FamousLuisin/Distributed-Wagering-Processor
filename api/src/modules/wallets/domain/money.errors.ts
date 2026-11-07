export class InvalidMoneyAmountError extends Error {
  constructor() {
    super(
      'Invalid money amount: expected a non-negative decimal string with at most 2 decimal places',
    );
    this.name = 'InvalidMoneyAmountError';
  }
}

export class InvalidCurrencyCodeError extends Error {
  constructor() {
    super('Invalid currency code: expected exactly 3 uppercase letters');
    this.name = 'InvalidCurrencyCodeError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(
      `Currency mismatch: cannot operate on ${leftCurrency} and ${rightCurrency}`,
    );
    this.name = 'CurrencyMismatchError';
  }
}
