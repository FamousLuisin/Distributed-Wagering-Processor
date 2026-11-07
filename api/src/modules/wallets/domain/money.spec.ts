import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import {
  CurrencyMismatchError,
  InvalidCurrencyCodeError,
  InvalidMoneyAmountError,
} from './money.errors.js';

describe('Money', () => {
  describe('creation and serialization', () => {
    it.each([
      ['25', '25.00'],
      ['25.0', '25.00'],
      ['25.01', '25.01'],
      ['0', '0.00'],
      ['00025.5', '25.50'],
    ])('normalizes %s to %s', (amount, normalized) => {
      const money = Money.from({ amount, currency: 'BRL' });

      expect(money.toJSON()).toEqual({ amount: normalized, currency: 'BRL' });
    });

    it('creates zero in the requested currency', () => {
      expect(Money.zero('BRL').toJSON()).toEqual({
        amount: '0.00',
        currency: 'BRL',
      });
    });

    it('serializes to a readable string with fixed scale and currency', () => {
      expect(Money.from({ amount: '5', currency: 'BRL' }).toString()).toBe(
        '5.00 BRL',
      );
    });

    it.each([
      '',
      ' ',
      '-1',
      '+1',
      '1.234',
      '1.',
      '.50',
      '1e2',
      'NaN',
      'Infinity',
    ])('rejects invalid amount %j', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyAmountError,
      );
    });

    it.each(['brl', 'BR', 'BRLX', 'B R', '1RL'])('rejects currency %j', (currency) => {
      expect(() => Money.zero(currency)).toThrow(InvalidCurrencyCodeError);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exact minor units', () => {
      const first = Money.from({ amount: '0.10', currency: 'BRL' });
      const second = Money.from({ amount: '0.20', currency: 'BRL' });

      expect(first.add(second).toJSON().amount).toBe('0.30');
      expect(second.subtract(first).toJSON().amount).toBe('0.10');
    });

    it('allows a negative result from subtraction without rounding', () => {
      const amount = Money.from({ amount: '0.01', currency: 'BRL' }).subtract(
        Money.from({ amount: '0.02', currency: 'BRL' }),
      );

      expect(amount.toJSON().amount).toBe('-0.01');
      expect(amount.isNegative()).toBe(true);
    });

    it('negates immutably', () => {
      const original = Money.from({ amount: '7.25', currency: 'BRL' });
      const negated = original.negate();

      expect(negated.toJSON().amount).toBe('-7.25');
      expect(original.toJSON().amount).toBe('7.25');
    });

    it('checks signs, zero, ordering, and equality', () => {
      const zero = Money.zero('BRL');
      const positive = Money.from({ amount: '1.00', currency: 'BRL' });
      const negative = positive.negate();

      expect(zero.isZero()).toBe(true);
      expect(positive.isPositive()).toBe(true);
      expect(negative.isNegative()).toBe(true);
      expect(zero.isLessThan(positive)).toBe(true);
      expect(positive.equals(Money.from({ amount: '1', currency: 'BRL' }))).toBe(
        true,
      );
      expect(positive.equals(Money.from({ amount: '1', currency: 'USD' }))).toBe(
        false,
      );
    });

    it('rejects arithmetic and ordering across different currencies', () => {
      const brl = Money.from({ amount: '1', currency: 'BRL' });
      const usd = Money.from({ amount: '1', currency: 'USD' });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });
});
