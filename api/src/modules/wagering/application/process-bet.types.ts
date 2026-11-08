import type { MoneyProps } from '../../wallets/domain/money.props.js';
import type { FailureCode, WagerTransactionStatus } from '../domain/wager-transaction.types.js';

export interface ProcessBetProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  money: MoneyProps;
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}
