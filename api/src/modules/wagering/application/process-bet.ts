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
  MissingWagerResultSnapshotError,
  WalletNotFoundError,
  WalletOwnershipMismatchError,
  WagerCurrencyMismatchError,
} from './process-bet.errors.js';
import type { ProcessBetProps, ProcessBetResult } from './process-bet.types.js';

@Injectable()
export class ProcessBet {
  constructor(private readonly em: EntityManager) {}

  async execute(props: ProcessBetProps): Promise<ProcessBetResult> {
    const money = Money.from(props.money);
    const payloadHash = ProcessBet.hashPayload(props, money);

    try {
      return await this.em.transactional((transactionalEm) =>
        this.processInsideTransaction(transactionalEm, props, money, payloadHash),
      );
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) {
        throw error;
      }

      return this.recoverUniqueConflict(props, payloadHash, error);
    }
  }

  private async processInsideTransaction(
    em: EntityManager,
    props: ProcessBetProps,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessBetResult> {
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
      balance: Money.from({ amount: walletEntity.balance, currency: walletEntity.currency }),
      version: walletEntity.version,
      createdAt: walletEntity.createdAt,
      updatedAt: walletEntity.updatedAt,
    });
    if (wallet.playerId !== props.playerId) throw new WalletOwnershipMismatchError();
    if (wallet.currency !== money.currency) throw new WagerCurrencyMismatchError();

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
      kind: WagerTransactionKind.Bet,
      money,
      createdAt: now,
    });

    let ledgerEntity: WalletLedgerEntryEntity | undefined;
    try {
      const change = wallet.debit(money, now);
      wager.markProcessed(undefined, now);

      walletEntity.balance = change.balanceAfter.toJSON().amount;
      walletEntity.version = change.version;
      walletEntity.updatedAt = wallet.updatedAt;

      const ledgerEntry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: wager.id,
        direction: LedgerDirection.Debit,
        money,
        balanceBefore: change.balanceBefore,
        balanceAfter: change.balanceAfter,
        createdAt: now,
      });
      ledgerEntity = new WalletLedgerEntryEntity();
      Object.assign(ledgerEntity, {
        id: ledgerEntry.id,
        walletId: ledgerEntry.walletId,
        transactionId: ledgerEntry.transactionId,
        direction: ledgerEntry.direction,
        amount: ledgerEntry.money.toJSON().amount,
        currency: ledgerEntry.money.currency,
        balanceBefore: ledgerEntry.balanceBefore.toJSON().amount,
        balanceAfter: ledgerEntry.balanceAfter.toJSON().amount,
        createdAt: ledgerEntry.createdAt,
      });
    } catch (error) {
      if (!(error instanceof InsufficientWalletFundsError)) throw error;
      wager.reject(FailureCode.InsufficientFunds);
    }

    const resultingBalance = wallet.balance.toJSON();
    const transactionEntity = this.toEntity(wager, resultingBalance.amount);
    em.persist(transactionEntity);
    if (ledgerEntity) em.persist(ledgerEntity);
    await em.flush();

    return {
      transactionId: wager.id,
      status: wager.status,
      balance: resultingBalance,
      idempotentReplay: false,
      ...(wager.failureCode ? { failureCode: wager.failureCode } : {}),
    };
  }

  private async recoverUniqueConflict(
    props: ProcessBetProps,
    payloadHash: string,
    originalError: UniqueConstraintViolationException,
  ): Promise<ProcessBetResult> {
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
  ): ProcessBetResult {
    if (entity.payloadHash !== payloadHash) throw new IdempotencyConflictError();
    if (entity.resultingBalance === undefined || entity.resultingBalance === null) {
      throw new MissingWagerResultSnapshotError();
    }
    return {
      transactionId: entity.id,
      status: entity.status as WagerTransactionStatus,
      balance: { amount: entity.resultingBalance, currency: entity.currency },
      idempotentReplay: true,
      ...(entity.failureCode ? { failureCode: entity.failureCode as FailureCode } : {}),
    };
  }

  private toEntity(
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

  private static hashPayload(props: ProcessBetProps, money: Money): string {
    const businessFields = {
      externalTransactionId: props.externalTransactionId,
      gameId: props.gameId,
      kind: WagerTransactionKind.Bet,
      money: money.toJSON(),
      playerId: props.playerId,
      providerId: props.providerId,
      roundId: props.roundId,
      walletId: props.walletId,
    };
    const canonicalJson = ProcessBet.canonicalJson(businessFields);
    return createHash('sha256').update(canonicalJson).digest('hex');
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
