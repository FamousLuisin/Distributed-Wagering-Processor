import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../domain/wager-transaction.types.js';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity.js';
import { ProcessWager } from './process-wager.js';
import { PENDING_REFERENCE_POLICY } from './pending-reference-policy.js';

@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly processWager: ProcessWager,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = await this.claimDueBatch();
        for (const item of claimed) {
          try {
            const result = await this.processWager.retryPendingReference(
              item.transactionId,
              item.leaseToken,
            );
            this.logger.debug(
              `Pending reference ${item.transactionId}: ${result}`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to retry pending reference ${item.transactionId}`,
              error instanceof Error ? error.stack : String(error),
            );
          }
        }
      } catch (error) {
        this.logger.error(
          'Pending-reference polling failed',
          error instanceof Error ? error.stack : String(error),
        );
      }

      if (!this.stopping) await this.delay(PENDING_REFERENCE_POLICY.pollIntervalMs);
    }
  }

  private async claimDueBatch(): Promise<
    Array<{ transactionId: string; leaseToken: string }>
  > {
    const em = this.em.fork({ clear: true });
    return em.transactional(async (em) => {
      const now = new Date();
      const rows = await em.find(
        WagerTransactionEntity,
        {
          status: WagerTransactionStatus.PendingReference,
          $and: [
            {
              $or: [
                { pendingReferenceNextAttemptAt: { $lte: now } },
                { pendingReferenceExpiresAt: { $lte: now } },
              ],
            },
            {
              $or: [
                { pendingReferenceLeaseUntil: null },
                { pendingReferenceLeaseUntil: { $lte: now } },
              ],
            },
          ],
        },
        {
          orderBy: { pendingReferenceNextAttemptAt: 'asc' },
          limit: PENDING_REFERENCE_POLICY.batchSize,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          refresh: true,
        },
      );

      const claimed = rows.map((row) => {
        const leaseToken = randomUUID();
        row.pendingReferenceLeaseToken = leaseToken;
        row.pendingReferenceLeaseUntil = new Date(
          now.getTime() + PENDING_REFERENCE_POLICY.leaseMs,
        );
        return { transactionId: row.id, leaseToken };
      });
      if (claimed.length > 0) await em.flush();
      return claimed;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
