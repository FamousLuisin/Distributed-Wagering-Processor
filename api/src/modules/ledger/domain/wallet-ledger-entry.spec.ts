import { describe, expect, it } from 'vitest';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import { Money } from '../../wallets/domain/money.js';
import { InvalidLedgerEntryError } from './wallet-ledger-entry.errors.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';

const at = new Date('2026-11-07T12:00:00.000Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const entry = (
  direction: LedgerDirection,
  moneyAmount: string,
  before: string,
  after: string,
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) =>
  WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction,
    money: money(moneyAmount),
    balanceBefore: money(before),
    balanceAfter: money(after),
    createdAt: at,
    ...overrides,
  });

describe('WalletLedgerEntry', () => {
  it('creates a balanced debit entry', () => {
    const debit = entry(LedgerDirection.Debit, '25.00', '100.00', '75.00');
    expect(debit.isBalanced()).toBe(true);
  });

  it('creates a balanced credit entry', () => {
    const credit = entry(LedgerDirection.Credit, '25.00', '75.00', '100.00');
    expect(credit.isBalanced()).toBe(true);
  });

  it('rejects incorrect arithmetic', () => {
    expect(() =>
      entry(LedgerDirection.Debit, '25.00', '100.00', '76.00'),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      entry(LedgerDirection.Credit, '25.00', '75.00', '99.00'),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects non-positive movement amounts', () => {
    expect(() =>
      entry(LedgerDirection.Credit, '0.00', '10.00', '10.00'),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      entry(LedgerDirection.Credit, '1.00', '10.00', '11.00', {
        money: money('1.00').negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects negative resulting balances and currency mismatches', () => {
    expect(() =>
      entry(LedgerDirection.Debit, '11.00', '10.00', '1.00', {
        balanceAfter: money('1.00').negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      entry(LedgerDirection.Credit, '1.00', '10.00', '11.00', {
        balanceAfter: Money.from({ amount: '11.00', currency: 'USD' }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects missing identifiers, invalid directions, and invalid timestamps', () => {
    expect(() => entry(LedgerDirection.Debit, '1.00', '2.00', '1.00', { id: ' ' })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      entry('INVALID' as LedgerDirection, '1.00', '2.00', '1.00'),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      entry(LedgerDirection.Credit, '1.00', '2.00', '3.00', {
        createdAt: new Date(Number.NaN),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rehydrates valid entries and protects its timestamp from mutation', () => {
    const created = entry(LedgerDirection.Debit, '1.00', '2.00', '1.00');
    const rehydrated = WalletLedgerEntry.rehydrate({
      id: created.id,
      walletId: created.walletId,
      transactionId: created.transactionId,
      direction: created.direction,
      money: created.money,
      balanceBefore: created.balanceBefore,
      balanceAfter: created.balanceAfter,
      createdAt: created.createdAt,
    });
    const date = rehydrated.createdAt;
    date.setFullYear(2000);

    expect(rehydrated.isBalanced()).toBe(true);
    expect(rehydrated.createdAt).toEqual(at);
  });
});
