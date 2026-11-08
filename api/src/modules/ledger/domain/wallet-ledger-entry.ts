import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import type { CreateLedgerEntryProps, LedgerEntryState } from './wallet-ledger-entry.types.js';
import { InvalidLedgerEntryError } from './wallet-ledger-entry.errors.js';

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: CreateLedgerEntryProps['money'],
    public readonly balanceBefore: CreateLedgerEntryProps['balanceBefore'],
    public readonly balanceAfter: CreateLedgerEntryProps['balanceAfter'],
    private readonly _createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.validate(props);
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date((props.createdAt ?? new Date()).getTime()),
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    WalletLedgerEntry.validate(state);
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt.getTime()),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  isBalanced(): boolean {
    const expectedBalance =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expectedBalance.equals(this.balanceAfter);
  }

  private static validate(props: CreateLedgerEntryProps): void {
    for (const [field, value] of [
      ['id', props.id],
      ['walletId', props.walletId],
      ['transactionId', props.transactionId],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidLedgerEntryError(`${field} must not be empty`);
      }
    }
    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError('Ledger direction is invalid');
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }
    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new InvalidLedgerEntryError('Ledger balances cannot be negative');
    }
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError(
        'Ledger amount and balances must use the same currency',
      );
    }
    if (props.createdAt !== undefined && !WalletLedgerEntry.isValidDate(props.createdAt)) {
      throw new InvalidLedgerEntryError('createdAt must be a valid date');
    }

    const expectedBalance =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);
    if (!expectedBalance.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        'Ledger balanceAfter does not match direction and amount',
      );
    }
  }

  private static isValidDate(value: Date): boolean {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }
}
