import type { Money } from './money.js';

export interface WalletBalanceChange {
  balanceBefore: Money;
  balanceAfter: Money;
  version: number;
}
