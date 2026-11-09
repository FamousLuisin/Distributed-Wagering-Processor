import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import { OutboxMessage } from '../../messaging/domain/outbox-message.js';
import { OutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.entity.js';
import { WalletLedgerEntry } from '../../ledger/domain/wallet-ledger-entry.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WagerTransaction as WagerTransactionAggregate } from '../../wagering/domain/wager-transaction.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction.types.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '../../wagering/domain/wagering-events.js';
import { WagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.entity.js';
import { Money } from '../domain/money.js';
import type { MoneyProps } from '../domain/money.props.js';
import { Wallet } from '../domain/wallet.js';
import { WalletEntity } from '../infrastructure/wallet.entity.js';

export interface CreateWalletProps {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface LedgerPageProps {
  limit: number;
  cursor?: string;
}

interface LedgerCursor {
  createdAt: string;
  id: string;
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`A wallet already exists for player ${playerId} in ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}

export class InvalidLedgerCursorError extends Error {
  constructor() {
    super('Ledger cursor is invalid');
    this.name = 'InvalidLedgerCursorError';
  }
}

@Injectable()
export class WalletApplicationService {
  private readonly logger = new Logger(WalletApplicationService.name);

  constructor(private readonly em: EntityManager) {}

  async create(props: CreateWalletProps) {
    const initialBalance = Money.from(props.initialBalance);
    const now = new Date();
    const wallet = Wallet.open(
      {
        id: randomUUID(),
        playerId: props.playerId,
        initialBalance,
      },
      now,
    );

    try {
      await this.em.transactional(async (em) => {
        const walletEntity = this.toWalletEntity(wallet);
        em.persist(walletEntity);
        // EntitySchema does not model the wager-to-wallet relation, so flush
        // the FK target first while remaining inside this SQL transaction.
        await em.flush();

        if (initialBalance.isPositive()) {
          const transaction = WagerTransactionAggregate.createOpening({
            id: randomUUID(),
            providerId: 'internal',
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `opening:${wallet.id}`,
            payloadHash: createHash('sha256')
              .update(`opening|${wallet.id}|${initialBalance.toJSON().amount}|${initialBalance.currency}`)
              .digest('hex'),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening',
            gameId: 'internal',
            money: initialBalance,
            createdAt: now,
          });
          const transactionEntity = this.toWagerEntity(
            transaction,
            initialBalance.toJSON().amount,
          );
          em.persist(transactionEntity);
          await em.flush();

          const ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            createdAt: now,
          });
          em.persist(this.toLedgerEntity(ledgerEntry));

          const eventContext = {
            transactionId: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: WagerTransactionKind.Opening,
            money: initialBalance.toJSON(),
            occurredAt: now,
          };
          const events = [
            WagerTransactionProcessed.from(eventContext),
            WalletBalanceChanged.from(eventContext, {
              direction: LedgerDirection.Credit,
              balanceBefore: Money.zero(initialBalance.currency).toJSON(),
              balanceAfter: initialBalance.toJSON(),
              walletVersion: wallet.version,
            }),
          ];
          em.persist(
            events.map((event) =>
              this.toOutboxEntity(OutboxMessage.enqueue(event, now)),
            ),
          );
          await em.flush();
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(props.playerId, initialBalance.currency);
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async get(walletId: string) {
    const entity = await this.em.fork({ clear: true }).findOne(
      WalletEntity,
      walletId,
    );
    if (!entity) throw new WalletNotFoundError(walletId);
    return this.toWalletResponse(entity);
  }

  async getLedger(walletId: string, page: LedgerPageProps) {
    const em = this.em.fork({ clear: true });
    const wallet = await em.findOne(WalletEntity, walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);

    const cursor = page.cursor ? this.decodeCursor(page.cursor) : undefined;
    const where = cursor
      ? {
          walletId,
          $or: [
            { createdAt: { $lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { $lt: cursor.id } },
          ],
        }
      : { walletId };
    const entries = await em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: page.limit + 1,
    });
    const hasMore = entries.length > page.limit;
    const items = entries.slice(0, page.limit).map((entry) =>
      this.toLedgerResponse(entry),
    );
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        hasMore && last
          ? this.encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      hasMore,
    };
  }

  async reconcile(walletId: string) {
    const em = this.em.fork({ clear: true });
    return em.transactional(async (tx) => {
      const wallet = await tx.findOne(WalletEntity, walletId, {
        lockMode: LockMode.PESSIMISTIC_READ,
      });
      if (!wallet) throw new WalletNotFoundError(walletId);

      const entries = await tx.find(
        WalletLedgerEntryEntity,
        { walletId },
        { orderBy: { createdAt: 'asc', id: 'asc' } },
      );
      const storedBalance = Money.from({
        amount: wallet.balance,
        currency: wallet.currency,
      });
      let calculatedBalance = Money.zero(wallet.currency);
      let ledgerEntriesConsistent = true;

      for (const entry of entries) {
        if (entry.currency !== wallet.currency) {
          ledgerEntriesConsistent = false;
          continue;
        }
        const amount = Money.from({ amount: entry.amount, currency: entry.currency });
        const balanceBefore = Money.from({
          amount: entry.balanceBefore,
          currency: entry.currency,
        });
        const balanceAfter = Money.from({
          amount: entry.balanceAfter,
          currency: entry.currency,
        });
        let expectedAfter: Money;
        if (entry.direction === LedgerDirection.Credit) {
          expectedAfter = balanceBefore.add(amount);
          calculatedBalance = calculatedBalance.add(amount);
        } else if (entry.direction === LedgerDirection.Debit) {
          expectedAfter = balanceBefore.subtract(amount);
          calculatedBalance = calculatedBalance.subtract(amount);
        } else {
          ledgerEntriesConsistent = false;
          continue;
        }

        if (
          !balanceAfter.equals(expectedAfter) ||
          expectedAfter.isNegative() ||
          amount.isNegative() ||
          amount.isZero()
        ) {
          ledgerEntriesConsistent = false;
        }
      }

      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = ledgerEntriesConsistent && difference.isZero();
      if (!consistent) {
        this.logger.warn(
          JSON.stringify({
            event: 'wallet_reconciliation_mismatch',
            walletId,
            checkedEntries: entries.length,
            ledgerEntriesConsistent,
          }),
        );
      }

      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });
  }

  private toWalletEntity(wallet: Wallet): WalletEntity {
    const entity = new WalletEntity();
    Object.assign(entity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    return entity;
  }

  private toWalletResponse(entity: WalletEntity) {
    return {
      id: entity.id,
      playerId: entity.playerId,
      balance: { amount: entity.balance, currency: entity.currency },
      version: entity.version,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  private toWagerEntity(
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
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: wager.status,
      failureCode: null,
      createdAt: wager.createdAt,
      processedAt: wager.processedAt,
      pendingReferenceAttempts: 0,
      pendingReferenceNextAttemptAt: null,
      pendingReferenceExpiresAt: null,
      pendingReferenceLeaseToken: null,
      pendingReferenceLeaseUntil: null,
    });
    return entity;
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

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private decodeCursor(value: string): LedgerCursor {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
        createdAt?: unknown;
        id?: unknown;
      };
      if (
        typeof parsed.createdAt !== 'string' ||
        Number.isNaN(Date.parse(parsed.createdAt)) ||
        typeof parsed.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
      ) {
        throw new Error('Invalid cursor fields');
      }
      return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
    } catch {
      throw new InvalidLedgerCursorError();
    }
  }

  private toLedgerResponse(entry: WalletLedgerEntryEntity) {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: { amount: entry.amount, currency: entry.currency },
      balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
      balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
      createdAt: entry.createdAt.toISOString(),
    };
  }
}
