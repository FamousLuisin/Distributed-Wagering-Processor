import type { Money } from './money.js';
import type { WalletBalanceChange } from './wallet.balance-change.js';
import type { WalletState } from './wallet.state.js';
import {
  InsufficientWalletFundsError,
  InvalidWalletBalanceError,
  InvalidWalletIdentityError,
  InvalidWalletMovementAmountError,
  InvalidWalletStateError,
  WalletCurrencyMismatchError,
} from './wallet.errors.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps, at: Date = new Date()): Wallet {
    Wallet.assertIdentity(props.id, 'id');
    Wallet.assertIdentity(props.playerId, 'playerId');
    Wallet.assertValidDate(at, 'createdAt');

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletBalanceError();
    }

    const timestamp = new Date(at.getTime());
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      timestamp,
      new Date(timestamp.getTime()),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    Wallet.assertIdentity(state.id, 'id');
    Wallet.assertIdentity(state.playerId, 'playerId');
    Wallet.assertValidDate(state.createdAt, 'createdAt');
    Wallet.assertValidDate(state.updatedAt, 'updatedAt');

    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new InvalidWalletStateError('Wallet version must be a positive integer');
    }
    if (state.currency !== state.balance.currency) {
      throw new WalletCurrencyMismatchError(state.currency, state.balance.currency);
    }
    if (state.balance.isNegative()) {
      throw new InvalidWalletBalanceError();
    }

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  debit(money: Money, at: Date = new Date()): WalletBalanceChange {
    this.assertSameCurrency(money);
    this.assertPositiveMovement(money);
    this.assertValidMovementDate(at);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientWalletFundsError();
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);
    this.applyBalanceChange(balanceAfter, at);

    return { balanceBefore, balanceAfter, version: this._version };
  }

  credit(money: Money, at: Date = new Date()): WalletBalanceChange {
    this.assertSameCurrency(money);
    this.assertPositiveMovement(money);
    this.assertValidMovementDate(at);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);
    this.applyBalanceChange(balanceAfter, at);

    return { balanceBefore, balanceAfter, version: this._version };
  }

  private applyBalanceChange(balance: Money, at: Date): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAt = new Date(at.getTime());
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new WalletCurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositiveMovement(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidWalletMovementAmountError();
    }
  }

  private assertValidMovementDate(at: Date): void {
    Wallet.assertValidDate(at, 'movement');
    if (at.getTime() < this._updatedAt.getTime()) {
      throw new InvalidWalletStateError(
        'Wallet movement timestamp cannot be earlier than updatedAt',
      );
    }
  }

  private static assertIdentity(value: string, field: 'id' | 'playerId'): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidWalletIdentityError(field);
    }
  }

  private static assertValidDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidWalletStateError(`Wallet ${field} must be a valid date`);
    }
  }
}
