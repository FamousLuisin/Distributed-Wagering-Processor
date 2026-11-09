import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../wallets/domain/money.js';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity.js';

export class WagerTransactionNotFoundError extends Error {
  constructor() {
    super('Wager transaction was not found');
    this.name = 'WagerTransactionNotFoundError';
  }
}

@Injectable()
export class WagerTransactionQueryService {
  constructor(private readonly em: EntityManager) {}

  async byId(transactionId: string) {
    const entity = await this.em.fork({ clear: true }).findOne(
      WagerTransactionEntity,
      transactionId,
    );
    if (!entity) throw new WagerTransactionNotFoundError();
    return this.toResponse(entity);
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string) {
    const entity = await this.em.fork({ clear: true }).findOne(
      WagerTransactionEntity,
      { providerId, externalTransactionId },
    );
    if (!entity) throw new WagerTransactionNotFoundError();
    return this.toResponse(entity);
  }

  private toResponse(entity: WagerTransactionEntity) {
    return {
      transactionId: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      playerId: entity.playerId,
      walletId: entity.walletId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }).toJSON(),
      status: entity.status,
      ...(entity.referenceExternalTransactionId
        ? { referenceExternalTransactionId: entity.referenceExternalTransactionId }
        : {}),
      ...(entity.referenceTransactionId
        ? { referenceTransactionId: entity.referenceTransactionId }
        : {}),
      ...(entity.failureCode ? { failureCode: entity.failureCode } : {}),
      ...(entity.resultingBalance !== undefined && entity.resultingBalance !== null
        ? {
            resultingBalance: {
              amount: entity.resultingBalance,
              currency: entity.currency,
            },
          }
        : {}),
      createdAt: entity.createdAt.toISOString(),
      ...(entity.processedAt
        ? { processedAt: entity.processedAt.toISOString() }
        : {}),
    };
  }
}
