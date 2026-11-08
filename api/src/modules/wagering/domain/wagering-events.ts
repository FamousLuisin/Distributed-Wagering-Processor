import { randomUUID } from 'node:crypto';
import type { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import type { MoneyProps } from '../../wallets/domain/money.props.js';
import type {
  FailureCode,
  WagerTransactionKind,
} from './wager-transaction.types.js';
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../messaging/domain/integration-event.js';

export interface WagerEventContext {
  correlationId?: string;
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  occurredAt: Date;
  causationId?: string;
}

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

export interface WalletBalanceChangedData extends WagerTransactionEventData {
  direction: LedgerDirection;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

function transactionData(context: WagerEventContext): WagerTransactionEventData {
  return {
    transactionId: context.transactionId,
    providerId: context.providerId,
    externalTransactionId: context.externalTransactionId,
    playerId: context.playerId,
    walletId: context.walletId,
    roundId: context.roundId,
    gameId: context.gameId,
    kind: context.kind,
    money: context.money,
    ...(context.referenceExternalTransactionId
      ? { referenceExternalTransactionId: context.referenceExternalTransactionId }
      : {}),
    ...(context.referenceTransactionId
      ? { referenceTransactionId: context.referenceTransactionId }
      : {}),
  };
}

function eventProps<T>(
  context: WagerEventContext,
  data: T,
): IntegrationEventProps<T> {
  return {
    eventId: randomUUID(),
    aggregateId: context.transactionId,
    correlationId: context.correlationId ?? context.transactionId,
    ...(context.causationId ? { causationId: context.causationId } : {}),
    occurredAt: context.occurredAt,
    data,
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(context: WagerEventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(eventProps(context, transactionData(context)));
  }

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    context: WagerEventContext,
    failureCode: FailureCode,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(
      eventProps(context, { ...transactionData(context), failureCode }),
    );
  }

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(context: WagerEventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      eventProps(context, transactionData(context)),
    );
  }

  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
    super(props);
  }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    context: WagerEventContext,
    data: Pick<
      WalletBalanceChangedData,
      'direction' | 'balanceBefore' | 'balanceAfter' | 'walletVersion'
    >,
  ): WalletBalanceChanged {
    const props = eventProps(context, { ...transactionData(context), ...data });
    return new WalletBalanceChanged({ ...props, aggregateId: context.walletId });
  }

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }
}
