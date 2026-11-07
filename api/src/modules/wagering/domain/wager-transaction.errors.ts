export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidWagerTransactionStateError extends Error {
  constructor(status: string) {
    super(`Cannot transition a wager transaction from terminal status ${status}`);
    this.name = 'InvalidWagerTransactionStateError';
  }
}

export class InvalidWagerTransactionTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid wager transaction transition: ${from} -> ${to}`);
    this.name = 'InvalidWagerTransactionTransitionError';
  }
}

export class InvalidWagerTransactionReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionReferenceError';
  }
}
