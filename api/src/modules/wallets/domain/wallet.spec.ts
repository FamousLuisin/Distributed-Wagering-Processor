import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import {
  InsufficientWalletFundsError,
  InvalidWalletBalanceError,
  InvalidWalletIdentityError,
  InvalidWalletMovementAmountError,
  InvalidWalletStateError,
  WalletCurrencyMismatchError,
} from './wallet.errors.js';
import { Wallet } from './wallet.js';

const at = new Date('2026-11-07T12:00:00.000Z');
const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

describe('Wallet', () => {
  describe('open', () => {
    it('opens with the initial balance and version 1', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00') },
        at,
      );

      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(at);
      expect(wallet.updatedAt).toEqual(at);
    });

    it('allows opening with a zero balance', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('BRL'),
      });

      expect(wallet.balance.isZero()).toBe(true);
    });

    it.each([
      { id: '', playerId: 'player-1' },
      { id: 'wallet-1', playerId: '  ' },
    ])('rejects empty identity fields', ({ id, playerId }) => {
      expect(() =>
        Wallet.open({ id, playerId, initialBalance: money('1.00') }),
      ).toThrow(InvalidWalletIdentityError);
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: money('1.00').negate(),
        }),
      ).toThrow(InvalidWalletBalanceError);
    });
  });

  describe('debit and credit', () => {
    it('debits and returns the before/after snapshot for the ledger', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('100.00') },
        at,
      );
      const movement = wallet.debit(money('25.25'), at);

      expect(movement.balanceBefore.toJSON().amount).toBe('100.00');
      expect(movement.balanceAfter.toJSON().amount).toBe('74.75');
      expect(wallet.balance.toJSON().amount).toBe('74.75');
      expect(wallet.version).toBe(2);
    });

    it('credits the balance and increments the version', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') },
        at,
      );
      const movement = wallet.credit(money('2.50'), new Date(at.getTime() + 1000));

      expect(movement.balanceBefore.toJSON().amount).toBe('10.00');
      expect(movement.balanceAfter.toJSON().amount).toBe('12.50');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(new Date(at.getTime() + 1000));
    });

    it('allows a debit that brings the balance exactly to zero', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') },
        at,
      );

      wallet.debit(money('10.00'), at);

      expect(wallet.balance.isZero()).toBe(true);
    });

    it('rejects a debit that would make the balance negative without mutation', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') },
        at,
      );

      expect(() => wallet.debit(money('10.01'), at)).toThrow(
        InsufficientWalletFundsError,
      );
      expect(wallet.balance.toJSON().amount).toBe('10.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects zero or negative movement amounts', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') },
        at,
      );

      expect(() => wallet.credit(Money.zero('BRL'), at)).toThrow(
        InvalidWalletMovementAmountError,
      );
      expect(() => wallet.debit(money('1.00').negate(), at)).toThrow(
        InvalidWalletMovementAmountError,
      );
      expect(wallet.version).toBe(1);
    });

    it('rejects a movement in a different currency without mutation', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') },
        at,
      );

      expect(() => wallet.credit(money('1.00', 'USD'), at)).toThrow(
        WalletCurrencyMismatchError,
      );
      expect(wallet.balance.toJSON().amount).toBe('10.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects invalid or backwards timestamps without mutation', () => {
      const wallet = Wallet.open(
        { id: 'wallet-1', playerId: 'player-1', initialBalance: money('10.00') },
        at,
      );

      expect(() => wallet.credit(money('1.00'), new Date(Number.NaN))).toThrow(
        InvalidWalletStateError,
      );
      expect(() =>
        wallet.credit(money('1.00'), new Date(at.getTime() - 1)),
      ).toThrow(InvalidWalletStateError);
      expect(wallet.balance.toJSON().amount).toBe('10.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('rehydrate', () => {
    it('reconstructs persisted state and protects its Date values from mutation', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: money('90.00'),
        version: 4,
        createdAt: at,
        updatedAt: new Date(at.getTime() + 1000),
      });
      const returnedDate = wallet.updatedAt;
      returnedDate.setFullYear(2000);

      expect(wallet.version).toBe(4);
      expect(wallet.updatedAt).toEqual(new Date(at.getTime() + 1000));
    });

    it('rejects invalid persisted version, currency, balance, or dates', () => {
      const state = {
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: money('90.00'),
        version: 4,
        createdAt: at,
        updatedAt: at,
      };

      expect(() => Wallet.rehydrate({ ...state, version: 0 })).toThrow(
        InvalidWalletStateError,
      );
      expect(() => Wallet.rehydrate({ ...state, currency: 'USD' })).toThrow(
        WalletCurrencyMismatchError,
      );
      expect(() => Wallet.rehydrate({ ...state, balance: money('1.00').negate() })).toThrow(
        InvalidWalletBalanceError,
      );
      expect(() =>
        Wallet.rehydrate({ ...state, updatedAt: new Date(Number.NaN) }),
      ).toThrow(InvalidWalletStateError);
    });
  });
});
