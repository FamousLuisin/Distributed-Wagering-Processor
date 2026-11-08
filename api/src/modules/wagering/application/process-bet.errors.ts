export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor() {
    super('Provider transaction id was already used with another idempotency key');
    this.name = 'ExternalTransactionConflictError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletOwnershipMismatchError extends Error {
  constructor() {
    super('The wallet does not belong to the submitted player');
    this.name = 'WalletOwnershipMismatchError';
  }
}

export class WagerCurrencyMismatchError extends Error {
  constructor() {
    super('The wager currency does not match the wallet currency');
    this.name = 'WagerCurrencyMismatchError';
  }
}

export class MissingWagerResultSnapshotError extends Error {
  constructor() {
    super('The stored wager does not contain its original balance result');
    this.name = 'MissingWagerResultSnapshotError';
  }
}
