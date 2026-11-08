import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
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
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidWagerAmountError,
  MissingWagerResultSnapshotError,
  WalletNotFoundError,
  WalletOwnershipMismatchError,
  WagerCurrencyMismatchError,
} from './process-wager.errors.js';
import type {
  ProcessWagerProps,
  ProcessWagerResult,
} from './process-wager.types.js';

type ReferenceResolution =
  | { type: 'none' }
  | { type: 'missing' }
  | { type: 'invalid'; failureCode: FailureCode }
  | { type: 'valid'; entity: WagerTransactionEntity };

@Injectable()
export class ProcessWager {
  constructor(private readonly em: EntityManager) {}

  async execute(props: ProcessWagerProps): Promise<ProcessWagerResult> {
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

  private async processInsideTransaction(
    em: EntityManager,
    props: ProcessWagerProps,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    const existing = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: props.idempotencyKey,
    });
    if (existing) return this.replay(existing, payloadHash);

    const walletEntity = await em.findOne(WalletEntity, props.walletId, {
      lockMode: LockMode.PESSIMISTIC_WRITE,
    });
    if (!walletEntity) throw new WalletNotFoundError(props.walletId);

    const duplicateAfterLock = await em.findOne(WagerTransactionEntity, {
      idempotencyKey: props.idempotencyKey,
    });
    if (duplicateAfterLock) return this.replay(duplicateAfterLock, payloadHash);

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

    // The ledger row references its wager row. Both flushes remain within this transaction.
    if (ledgerEntity) {
      em.persist(ledgerEntity);
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
      referenceExternalTransactionId: entity.referenceExternalTransactionId,
      createdAt: entity.createdAt,
      status: entity.status as WagerTransactionStatus,
      referenceTransactionId: entity.referenceTransactionId,
      failureCode: entity.failureCode as FailureCode | undefined,
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
