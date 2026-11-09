import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import { InboxMessage } from '../../messaging/domain/inbox-message.js';
import { InboxMessageEntity } from '../../messaging/infrastructure/inbox-message.entity.js';
import { OutboxMessage } from '../../messaging/domain/outbox-message.js';
import { OutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.entity.js';
import { WalletLedgerEntry } from '../../ledger/domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { InsufficientWalletFundsError } from '../../wallets/domain/wallet.errors.js';
import { Money } from '../../wallets/domain/money.js';
import { Wallet } from '../../wallets/domain/wallet.js';
import { WalletEntity } from '../../wallets/infrastructure/wallet.entity.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.types.js';
import { WagerTransaction as WagerTransactionAggregate } from '../domain/wager-transaction.js';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity.js';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type WagerEventContext,
} from '../domain/wagering-events.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidWagerAmountError,
  MissingWagerResultSnapshotError,
  InboxMessagePayloadConflictError,
  InboxMessageWithoutWagerError,
  WalletNotFoundError,
  WalletOwnershipMismatchError,
  WagerCurrencyMismatchError,
} from './process-wager.errors.js';
import type {
  ProcessWagerProps,
  ProcessWagerResult,
} from './process-wager.types.js';
import {
  pendingReferenceRetryDelay,
  PENDING_REFERENCE_POLICY,
} from './pending-reference-policy.js';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { logEvent } from '../../../shared/observability/structured-log.js';

type ReferenceResolution =
  | { type: 'none' }
  | { type: 'missing' }
  | { type: 'invalid'; failureCode: FailureCode }
  | { type: 'valid'; entity: WagerTransactionEntity };

export type PendingReferenceRetryResult =
  'stale' | 'rescheduled' | 'processed' | 'rejected';

@Injectable()
export class ProcessWager {
  private readonly logger = new Logger(ProcessWager.name);

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService = new MetricsService(),
  ) {}

  async retryPendingReference(
    transactionId: string,
    leaseToken: string,
  ): Promise<PendingReferenceRetryResult> {
    const em = this.em.fork({ clear: true });
    return em.transactional(async (em) => {
      const candidate = await em.findOne(
        WagerTransactionEntity,
        {
          id: transactionId,
          status: WagerTransactionStatus.PendingReference,
        },
        { refresh: true },
      );
      if (!candidate || candidate.pendingReferenceLeaseToken !== leaseToken) {
        return 'stale';
      }

      // Keep the same lock order as new wager processing: wallet, then wager.
      const walletEntity = await em.findOne(WalletEntity, candidate.walletId, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      if (!walletEntity) throw new WalletNotFoundError(candidate.walletId);

      const wagerEntity = await em.findOne(
        WagerTransactionEntity,
        { id: transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
      if (
        !wagerEntity ||
        wagerEntity.status !== WagerTransactionStatus.PendingReference ||
        wagerEntity.pendingReferenceLeaseToken !== leaseToken
      ) {
        return 'stale';
      }

      const now = new Date();
      const attempt = wagerEntity.pendingReferenceAttempts + 1;
      const money = Money.from({
        amount: wagerEntity.amount,
        currency: wagerEntity.currency,
      });
      const props: ProcessWagerProps = {
        providerId: wagerEntity.providerId,
        externalTransactionId: wagerEntity.externalTransactionId,
        idempotencyKey: wagerEntity.idempotencyKey,
        playerId: wagerEntity.playerId,
        walletId: wagerEntity.walletId,
        roundId: wagerEntity.roundId,
        gameId: wagerEntity.gameId,
        kind: wagerEntity.kind as ProcessWagerProps['kind'],
        money: money.toJSON(),
        referenceExternalTransactionId:
          wagerEntity.referenceExternalTransactionId,
      };
      const wager = this.toAggregate(wagerEntity);
      const reference = await this.resolveReference(em, props, money);

      if (reference.type === 'missing') {
        const expiresAt = wagerEntity.pendingReferenceExpiresAt;
        if (
          attempt >= PENDING_REFERENCE_POLICY.maxAttempts ||
          !expiresAt ||
          now >= expiresAt
        ) {
          wager.reject(FailureCode.ReferenceNotFound);
        } else {
          const nextAttemptAt = new Date(
            Math.min(
              now.getTime() + pendingReferenceRetryDelay(attempt),
              expiresAt.getTime(),
            ),
          );
          wagerEntity.pendingReferenceAttempts = attempt;
          wagerEntity.pendingReferenceNextAttemptAt = nextAttemptAt;
          wagerEntity.pendingReferenceLeaseToken = null;
          wagerEntity.pendingReferenceLeaseUntil = null;
          await em.flush();
          return 'rescheduled';
        }
      } else if (reference.type === 'invalid') {
        wager.reject(reference.failureCode);
      } else if (reference.type === 'valid' && this.isReversal(props.kind)) {
        const previousReversal = await em.findOne(WagerTransactionEntity, {
          referenceTransactionId: reference.entity.id,
          kind: props.kind,
        });
        if (previousReversal) wager.reject(FailureCode.DuplicateReversal);
      }

      const referenceEntity =
        reference.type === 'valid' ? reference.entity : undefined;
      const referenceAggregate = referenceEntity
        ? this.toAggregate(referenceEntity)
        : undefined;
      const wallet = Wallet.rehydrate({
        id: walletEntity.id,
        playerId: walletEntity.playerId,
        currency: walletEntity.currency,
        balance: Money.from({
          amount: walletEntity.balance,
          currency: walletEntity.currency,
        }),
        version: walletEntity.version,
        createdAt: walletEntity.createdAt,
        updatedAt: walletEntity.updatedAt,
      });
      let ledgerEntity: WalletLedgerEntryEntity | undefined;

      if (wager.status === WagerTransactionStatus.PendingReference) {
        if (props.kind === WagerTransactionKind.Loss) {
          wager.markProcessed(referenceEntity?.id, now);
        } else {
          const direction = wager.ledgerDirectionFor(referenceAggregate);
          try {
            const change =
              direction === LedgerDirection.Debit
                ? wallet.debit(money, now)
                : wallet.credit(money, now);
            wager.markProcessed(referenceEntity?.id, now);
            walletEntity.balance = change.balanceAfter.toJSON().amount;
            walletEntity.version = change.version;
            walletEntity.updatedAt = wallet.updatedAt;

            ledgerEntity = this.toLedgerEntity(
              WalletLedgerEntry.create({
                id: randomUUID(),
                walletId: wallet.id,
                transactionId: wager.id,
                direction,
                money,
                balanceBefore: change.balanceBefore,
                balanceAfter: change.balanceAfter,
                createdAt: now,
              }),
            );
          } catch (error) {
            if (!(error instanceof InsufficientWalletFundsError)) throw error;
            wager.reject(
              props.kind === WagerTransactionKind.Bet
                ? FailureCode.InsufficientFunds
                : FailureCode.ReversalInsufficientFunds,
            );
          }
        }
      }

      wagerEntity.referenceTransactionId = wager.referenceTransactionId;
      wagerEntity.status = wager.status;
      wagerEntity.failureCode = wager.failureCode;
      wagerEntity.processedAt = wager.processedAt;
      wagerEntity.resultingBalance = wallet.balance.toJSON().amount;
      wagerEntity.pendingReferenceAttempts = attempt;
      wagerEntity.pendingReferenceNextAttemptAt = null;
      wagerEntity.pendingReferenceExpiresAt = null;
      wagerEntity.pendingReferenceLeaseToken = null;
      wagerEntity.pendingReferenceLeaseUntil = null;
      await em.flush();

      if (ledgerEntity) {
        em.persist(ledgerEntity);
        await em.flush();
      }

      const eventContext: WagerEventContext = {
        transactionId: wager.id,
        providerId: wagerEntity.providerId,
        externalTransactionId: wagerEntity.externalTransactionId,
        playerId: wagerEntity.playerId,
        walletId: wagerEntity.walletId,
        roundId: wagerEntity.roundId,
        gameId: wagerEntity.gameId,
        kind: props.kind,
        money: money.toJSON(),
        referenceExternalTransactionId:
          wagerEntity.referenceExternalTransactionId,
        referenceTransactionId: wager.referenceTransactionId,
        occurredAt: now,
      };
      const events = [];
      if (wager.status === WagerTransactionStatus.Processed) {
        events.push(WagerTransactionProcessed.from(eventContext));
      } else if (wager.status === WagerTransactionStatus.Rejected) {
        if (!wager.failureCode) {
          throw new Error('Rejected wager is missing its failure code');
        }
        events.push(
          WagerTransactionRejected.from(eventContext, wager.failureCode),
        );
      }

      if (ledgerEntity) {
        events.push(
          WalletBalanceChanged.from(eventContext, {
            direction: ledgerEntity.direction as LedgerDirection,
            balanceBefore: {
              amount: ledgerEntity.balanceBefore,
              currency: ledgerEntity.currency,
            },
            balanceAfter: {
              amount: ledgerEntity.balanceAfter,
              currency: ledgerEntity.currency,
            },
            walletVersion: walletEntity.version,
          }),
        );
      }
      if (events.length > 0) {
        em.persist(
          events.map((event) =>
            this.toOutboxEntity(OutboxMessage.enqueue(event, now)),
          ),
        );
        await em.flush();
      }

      return wager.status === WagerTransactionStatus.Processed
        ? 'processed'
        : 'rejected';
    });
  }

  async recordTerminalInboxMessage(props: {
    messageId: string;
    consumerName: string;
    payloadHash: string;
    receivedAt?: Date;
  }): Promise<void> {
    await this.em.transactional(async (em) => {
      const existing = await em.findOne(InboxMessageEntity, {
        consumerName: props.consumerName,
        messageId: props.messageId,
      });
      if (existing) {
        if (existing.payloadHash !== props.payloadHash) {
          throw new InboxMessagePayloadConflictError();
        }
        if (!existing.processedAt) {
          existing.processedAt = new Date();
          await em.flush();
        }
        return;
      }
      await this.persistInboxMessage(em, props, new Date());
      await em.flush();
    });
  }

  async execute(props: ProcessWagerProps): Promise<ProcessWagerResult> {
    const startedAt = Date.now();
    let status = 'error';
    const correlatedProps = {
      ...props,
      correlationId: props.correlationId ?? randomUUID(),
    };
    try {
      const result = await this.executeWithRecovery(correlatedProps);
      status = result.status;
      this.metrics.increment(
        'wagering_transactions_total',
        'Wagering transaction outcomes, including idempotent replays.',
        { status: result.status, kind: props.kind },
      );
      if (result.idempotentReplay) {
        this.metrics.increment(
          'wagering_duplicates_total',
          'Requests served from the persisted idempotency result.',
          { source: 'idempotency_replay' },
        );
      }
      logEvent(
        this.logger,
        'log',
        ProcessWager.name,
        'wager_processing_completed',
        {
          correlationId: correlatedProps.correlationId,
          causationId: correlatedProps.causationId,
          messageId: correlatedProps.inboxMessage?.messageId,
          transactionId: result.transactionId,
          walletId: props.walletId,
          providerId: props.providerId,
          externalTransactionId: props.externalTransactionId,
          status: result.status,
          errorCode: result.failureCode,
          durationMs: Date.now() - startedAt,
          kind: props.kind,
          idempotentReplay: result.idempotentReplay,
        },
      );
      return result;
    } catch (error) {
      const sqlState = this.sqlState(error);
      if (sqlState && ['40P01', '55P03', '40001'].includes(sqlState)) {
        this.metrics.increment(
          'database_lock_conflicts_total',
          'Database deadlock, lock timeout, or serialization conflicts.',
          { sqlstate: sqlState },
        );
      }
      logEvent(
        this.logger,
        'error',
        ProcessWager.name,
        'wager_processing_failed',
        {
          correlationId: correlatedProps.correlationId,
          causationId: correlatedProps.causationId,
          messageId: correlatedProps.inboxMessage?.messageId,
          walletId: props.walletId,
          providerId: props.providerId,
          externalTransactionId: props.externalTransactionId,
          errorCode: this.errorName(error),
          durationMs: Date.now() - startedAt,
          kind: props.kind,
        },
      );
      throw error;
    } finally {
      this.metrics.observe(
        'wager_processing_duration_seconds',
        'Time spent processing a wagering request.',
        (Date.now() - startedAt) / 1_000,
        { kind: props.kind, status },
      );
    }
  }

  private async executeWithRecovery(
    props: ProcessWagerProps,
  ): Promise<ProcessWagerResult> {
    const money = Money.from(props.money);
    if (!money.isPositive()) throw new InvalidWagerAmountError();
    const payloadHash = ProcessWager.hashPayload(props, money);

    try {
      return await this.em.transactional((transactionalEm) =>
        this.processInsideTransaction(
          transactionalEm,
          props,
          money,
          payloadHash,
        ),
      );
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) throw error;
      return this.recoverUniqueConflict(props, payloadHash, error);
    }
  }

  private sqlState(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof current !== 'object' || current === null) return undefined;
      if ('code' in current) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string') return code;
      }
      current =
        'cause' in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return undefined;
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }

  private async processInsideTransaction(
    em: EntityManager,
    props: ProcessWagerProps,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const inboxReplay = await this.replayInboxMessage(em, props, payloadHash);
    if (inboxReplay) return inboxReplay;

    const existing = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: props.idempotencyKey,
    });
    if (existing) {
      await this.persistInboxMessage(em, props.inboxMessage, new Date());
      if (props.inboxMessage) await em.flush();
      return this.replay(existing, payloadHash);
    }

    const walletEntity = await em.findOne(WalletEntity, props.walletId, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    if (!walletEntity) throw new WalletNotFoundError(props.walletId);

    const duplicateAfterLock = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: props.idempotencyKey,
    });
    const inboxReplayAfterLock = await this.replayInboxMessage(
      em,
      props,
      payloadHash,
    );
    if (inboxReplayAfterLock) return inboxReplayAfterLock;
    if (duplicateAfterLock) {
      await this.persistInboxMessage(em, props.inboxMessage, new Date());
      if (props.inboxMessage) await em.flush();
      return this.replay(duplicateAfterLock, payloadHash);
    }

    const externalDuplicate = await em.findOne(WagerTransactionEntity, {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
    });
    if (externalDuplicate) throw new ExternalTransactionConflictError();

    const wallet = Wallet.rehydrate({
      id: walletEntity.id,
      playerId: walletEntity.playerId,
      currency: walletEntity.currency,
      balance: Money.from({
        amount: walletEntity.balance,
        currency: walletEntity.currency,
      }),
      version: walletEntity.version,
      createdAt: walletEntity.createdAt,
      updatedAt: walletEntity.updatedAt,
    });
    if (wallet.playerId !== props.playerId)
      throw new WalletOwnershipMismatchError();
    if (wallet.currency !== money.currency)
      throw new WagerCurrencyMismatchError();

    const now = new Date();
    const wager = WagerTransactionAggregate.create({
      id: randomUUID(),
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      createdAt: now,
    });

    const reference = await this.resolveReference(em, props, money);
    if (reference.type === 'missing') {
      wager.markPendingReference();
    } else if (reference.type === 'invalid') {
      wager.reject(reference.failureCode);
    } else if (reference.type === 'valid' && this.isReversal(props.kind)) {
      const previousReversal = await em.findOne(WagerTransactionEntity, {
        referenceTransactionId: reference.entity.id,
        kind: props.kind,
      });
      if (previousReversal) wager.reject(FailureCode.DuplicateReversal);
    }

    const referenceEntity =
      reference.type === 'valid' ? reference.entity : undefined;
    const referenceAggregate = referenceEntity
      ? this.toAggregate(referenceEntity)
      : undefined;
    let ledgerEntity: WalletLedgerEntryEntity | undefined;

    if (wager.status === WagerTransactionStatus.Pending) {
      if (props.kind === WagerTransactionKind.Loss) {
        wager.markProcessed(referenceEntity?.id, now);
      } else {
        const direction = wager.ledgerDirectionFor(referenceAggregate);
        try {
          const change =
            direction === LedgerDirection.Debit
              ? wallet.debit(money, now)
              : wallet.credit(money, now);
          wager.markProcessed(referenceEntity?.id, now);

          walletEntity.balance = change.balanceAfter.toJSON().amount;
          walletEntity.version = change.version;
          walletEntity.updatedAt = wallet.updatedAt;

          const ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: wager.id,
            direction,
            money,
            balanceBefore: change.balanceBefore,
            balanceAfter: change.balanceAfter,
            createdAt: now,
          });
          ledgerEntity = this.toLedgerEntity(ledgerEntry);
        } catch (error) {
          if (!(error instanceof InsufficientWalletFundsError)) throw error;
          const failureCode =
            props.kind === WagerTransactionKind.Bet
              ? FailureCode.InsufficientFunds
              : FailureCode.ReversalInsufficientFunds;
          wager.reject(failureCode);
        }
      }
    }

    const resultingBalance = wallet.balance.toJSON();
    em.persist(this.toTransactionEntity(wager, resultingBalance.amount));
    await em.flush();

    if (ledgerEntity) {
      em.persist(ledgerEntity);
      await em.flush();
    }

    await this.persistInboxMessage(em, props.inboxMessage, now);

    const eventContext: WagerEventContext = {
      correlationId: props.correlationId,
      causationId: props.causationId,
      transactionId: wager.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      referenceTransactionId: wager.referenceTransactionId,
      occurredAt: now,
    };
    const outboxMessages = [];
    if (wager.status === WagerTransactionStatus.Processed) {
      outboxMessages.push(WagerTransactionProcessed.from(eventContext));
    } else if (wager.status === WagerTransactionStatus.Rejected) {
      if (!wager.failureCode) {
        throw new Error('Rejected wager is missing its failure code');
      }
      outboxMessages.push(
        WagerTransactionRejected.from(eventContext, wager.failureCode),
      );
    } else if (wager.status === WagerTransactionStatus.PendingReference) {
      outboxMessages.push(WagerTransactionPendingReference.from(eventContext));
    }

    if (ledgerEntity) {
      outboxMessages.push(
        WalletBalanceChanged.from(eventContext, {
          direction: ledgerEntity.direction as LedgerDirection,
          balanceBefore: {
            amount: ledgerEntity.balanceBefore,
            currency: ledgerEntity.currency,
          },
          balanceAfter: {
            amount: ledgerEntity.balanceAfter,
            currency: ledgerEntity.currency,
          },
          walletVersion: walletEntity.version,
        }),
      );
    }

    if (outboxMessages.length > 0) {
      em.persist(
        outboxMessages.map((event) =>
          this.toOutboxEntity(OutboxMessage.enqueue(event, now)),
        ),
      );
      await em.flush();
    }

    return {
      transactionId: wager.id,
      status: wager.status,
      balance: resultingBalance,
      idempotentReplay: false,
      ...(wager.failureCode ? { failureCode: wager.failureCode } : {}),
    };
  }

  private async resolveReference(
    em: EntityManager,
    props: ProcessWagerProps,
    money: Money,
  ): Promise<ReferenceResolution> {
    const externalId = props.referenceExternalTransactionId;
    if (!externalId) return { type: 'none' };

    const reference = await em.findOne(WagerTransactionEntity, {
      providerId: props.providerId,
      externalTransactionId: externalId,
    });
    if (!reference) {
      const anotherProviderReference = await em.findOne(
        WagerTransactionEntity,
        {
          externalTransactionId: externalId,
        },
      );
      return anotherProviderReference
        ? {
            type: 'invalid',
            failureCode: FailureCode.ReferenceProviderMismatch,
          }
        : { type: 'missing' };
    }

    if (reference.playerId !== props.playerId) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferencePlayerMismatch,
      };
    }
    if (reference.walletId !== props.walletId) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferenceWalletMismatch,
      };
    }
    if (reference.currency !== money.currency) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferenceCurrencyMismatch,
      };
    }
    if (reference.roundId !== props.roundId) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferenceRoundMismatch,
      };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferenceNotProcessed,
      };
    }
    if (
      !this.allowedReferenceKinds(props.kind).includes(
        reference.kind as WagerTransactionKind,
      )
    ) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferenceKindNotAllowed,
      };
    }

    if (
      this.isReversal(props.kind) &&
      !Money.from({
        amount: reference.amount,
        currency: reference.currency,
      }).equals(money)
    ) {
      return {
        type: 'invalid',
        failureCode: FailureCode.ReferenceAmountMismatch,
      };
    }

    return { type: 'valid', entity: reference };
  }

  private allowedReferenceKinds(
    kind: WagerTransactionKind,
  ): WagerTransactionKind[] {
    switch (kind) {
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Refund:
        return [WagerTransactionKind.Bet];
      case WagerTransactionKind.Rollback:
        return [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ];
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Opening:
        return [];
    }
  }

  private isReversal(kind: WagerTransactionKind): boolean {
    return (
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
    );
  }

  private toAggregate(
    entity: WagerTransactionEntity,
  ): WagerTransactionAggregate {
    return WagerTransactionAggregate.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind as WagerTransactionKind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      createdAt: entity.createdAt,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode:
        (entity.failureCode as FailureCode | null | undefined) ?? undefined,
      processedAt: entity.processedAt,
    });
  }

  private toLedgerEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    Object.assign(entity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
    return entity;
  }

  private async recoverUniqueConflict(
    props: ProcessWagerProps,
    payloadHash: string,
    originalError: UniqueConstraintViolationException,
  ): Promise<ProcessWagerResult> {
    const em = this.em.fork({ clear: true });
    if (props.inboxMessage) {
      const inbox = await em.findOne(InboxMessageEntity, {
        consumerName: props.inboxMessage.consumerName,
        messageId: props.inboxMessage.messageId,
      });
      if (inbox) {
        if (inbox.payloadHash !== props.inboxMessage.payloadHash) {
          throw new InboxMessagePayloadConflictError();
        }
        const inboxWager = await em.findOne(WagerTransactionEntity, {
          idempotencyKey: props.idempotencyKey,
        });
        if (inboxWager) return this.replay(inboxWager, payloadHash);
      }
    }
    const byKey = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: props.idempotencyKey,
    });
    if (byKey) return this.replay(byKey, payloadHash);

    const byExternalId = await em.findOne(WagerTransactionEntity, {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
    });
    if (byExternalId) throw new ExternalTransactionConflictError();
    throw originalError;
  }

  private async replayInboxMessage(
    em: EntityManager,
    props: ProcessWagerProps,
    payloadHash: string,
  ): Promise<ProcessWagerResult | undefined> {
    const inboxProps = props.inboxMessage;
    if (!inboxProps) return undefined;
    const inbox = await em.findOne(InboxMessageEntity, {
      consumerName: inboxProps.consumerName,
      messageId: inboxProps.messageId,
    });
    if (!inbox) return undefined;
    if (inbox.payloadHash !== inboxProps.payloadHash) {
      throw new InboxMessagePayloadConflictError();
    }

    const wager = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: props.idempotencyKey,
    });
    if (!wager) throw new InboxMessageWithoutWagerError();
    if (!inbox.processedAt) {
      inbox.processedAt = new Date();
      await em.flush();
    }
    return this.replay(wager, payloadHash);
  }

  private async persistInboxMessage(
    em: EntityManager,
    inboxProps: ProcessWagerProps['inboxMessage'],
    processedAt: Date,
  ): Promise<void> {
    if (!inboxProps) return;
    const inbox = InboxMessage.receive({
      ...inboxProps,
      receivedAt: inboxProps.receivedAt ?? processedAt,
    });
    inbox.markProcessed(processedAt);
    const entity = new InboxMessageEntity();
    Object.assign(entity, {
      messageId: inbox.messageId,
      consumerName: inbox.consumerName,
      payloadHash: inbox.payloadHash,
      receivedAt: inbox.receivedAt,
      processedAt: inbox.processedAt,
    });
    em.persist(entity);
  }

  private replay(
    entity: WagerTransactionEntity,
    payloadHash: string,
  ): ProcessWagerResult {
    if (entity.payloadHash !== payloadHash)
      throw new IdempotencyConflictError();
    if (
      entity.resultingBalance === undefined ||
      entity.resultingBalance === null
    ) {
      throw new MissingWagerResultSnapshotError();
    }
    return {
      transactionId: entity.id,
      status: entity.status as WagerTransactionStatus,
      balance: { amount: entity.resultingBalance, currency: entity.currency },
      idempotentReplay: true,
      ...(entity.failureCode
        ? { failureCode: entity.failureCode as FailureCode }
        : {}),
    };
  }

  private toTransactionEntity(
    wager: WagerTransactionAggregate,
    resultingBalance: string,
  ): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    const pendingReference =
      wager.status === WagerTransactionStatus.PendingReference;
    Object.assign(entity, {
      id: wager.id,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      idempotencyKey: wager.idempotencyKey,
      payloadHash: wager.payloadHash,
      walletId: wager.walletId,
      playerId: wager.playerId,
      roundId: wager.roundId,
      gameId: wager.gameId,
      kind: wager.kind,
      amount: wager.money.toJSON().amount,
      currency: wager.money.currency,
      resultingBalance,
      referenceExternalTransactionId: wager.referenceExternalTransactionId,
      referenceTransactionId: wager.referenceTransactionId,
      status: wager.status,
      failureCode: wager.failureCode,
      createdAt: wager.createdAt,
      processedAt: wager.processedAt,
      pendingReferenceAttempts: 0,
      pendingReferenceNextAttemptAt: pendingReference
        ? new Date(
            wager.createdAt.getTime() + PENDING_REFERENCE_POLICY.baseDelayMs,
          )
        : null,
      pendingReferenceExpiresAt: pendingReference
        ? new Date(wager.createdAt.getTime() + PENDING_REFERENCE_POLICY.ttlMs)
        : null,
      pendingReferenceLeaseToken: null,
      pendingReferenceLeaseUntil: null,
    });
    return entity;
  }

  private toOutboxEntity(message: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    Object.assign(entity, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      createdAt: message.createdAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
      leaseToken: message.leaseToken ?? null,
      leaseUntil: message.leaseUntil ?? null,
      lastError: message.lastError ?? null,
    });
    return entity;
  }

  private static hashPayload(props: ProcessWagerProps, money: Money): string {
    const businessFields = {
      externalTransactionId: props.externalTransactionId,
      gameId: props.gameId,
      kind: props.kind,
      money: money.toJSON(),
      playerId: props.playerId,
      providerId: props.providerId,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      roundId: props.roundId,
      walletId: props.walletId,
    };
    return createHash('sha256')
      .update(ProcessWager.canonicalJson(businessFields))
      .digest('hex');
  }

  private static canonicalJson(value: unknown): string {
    const sortRecursively = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(sortRecursively);
      if (input !== null && typeof input === 'object') {
        return Object.fromEntries(
          Object.entries(input)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nestedValue]) => [key, sortRecursively(nestedValue)]),
        );
      }
      return input;
    };
    return JSON.stringify(sortRecursively(value));
  }
}
