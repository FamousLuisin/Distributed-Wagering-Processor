import type { Money } from '../../wallets/domain/money.js';
import type { LedgerDirection } from '../../../shared/domain/ledger-direction.js';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  createdAt: Date;
}
