export class InvalidWalletIdentityError extends Error {
  constructor(field: 'id' | 'playerId') {
    super(`Wallet ${field} must not be empty`);
    this.name = 'InvalidWalletIdentityError';
  }
}

export class InvalidWalletBalanceError extends Error {
  constructor() {
    super('Wallet balance cannot be negative');
    this.name = 'InvalidWalletBalanceError';
  }
}

export class InsufficientWalletFundsError extends Error {
  constructor() {
    super('Wallet has insufficient funds');
    this.name = 'InsufficientWalletFundsError';
  }
}

export class InvalidWalletMovementAmountError extends Error {
  constructor() {
    super('Wallet movement amount must be positive');
    this.name = 'InvalidWalletMovementAmountError';
  }
}

export class WalletCurrencyMismatchError extends Error {
  constructor(walletCurrency: string, moneyCurrency: string) {
    super(
      `Wallet currency mismatch: wallet uses ${walletCurrency}, movement uses ${moneyCurrency}`,
    );
    this.name = 'WalletCurrencyMismatchError';
  }
}

export class InvalidWalletStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletStateError';
  }
}
