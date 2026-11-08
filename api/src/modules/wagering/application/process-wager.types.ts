import type { MoneyProps } from '../../wallets/domain/money.props.js';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.types.js';

export interface ProcessWagerProps {
  /** Transport metadata; excluded from the business payload hash. */
  correlationId?: string;
  causationId?: string;
  inboxMessage?: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt?: Date;
  };
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}
