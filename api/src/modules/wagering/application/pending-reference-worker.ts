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
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { logEvent } from '../../../shared/observability/structured-log.js';

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
    private readonly metrics: MetricsService = new MetricsService(),
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
            this.metrics.increment(
              'pending_reference_attempts_total',
              'Pending-reference worker results by outcome.',
              { outcome: result },
            );
            if (result === 'rescheduled') {
              this.metrics.increment(
                'messaging_retries_total',
                'Retry attempts scheduled by asynchronous processing components.',
                { component: 'pending_reference_worker' },
              );
            }
            if (result === 'processed' || result === 'rejected') {
              this.metrics.increment(
                'wagering_transactions_total',
                'Wagering transaction status transitions, including reference recovery.',
                { status: result.toUpperCase(), kind: item.kind },
              );
            }
            logEvent(
              this.logger,
              'debug',
              PendingReferenceWorker.name,
              'pending_reference_attempt_completed',
              {
                transactionId: item.transactionId,
                walletId: item.walletId,
                providerId: item.providerId,
                externalTransactionId: item.externalTransactionId,
                status: result,
              },
            );
          } catch (error) {
            logEvent(
              this.logger,
              'error',
              PendingReferenceWorker.name,
              'pending_reference_attempt_failed',
              {
                transactionId: item.transactionId,
                walletId: item.walletId,
                providerId: item.providerId,
                externalTransactionId: item.externalTransactionId,
                errorCode: error instanceof Error ? error.name : 'UnknownError',
              },
            );
          }
        }
      } catch (error) {
        logEvent(
          this.logger,
          'error',
          PendingReferenceWorker.name,
          'pending_reference_poll_failed',
          {
            errorCode: error instanceof Error ? error.name : 'UnknownError',
          },
        );
      }

      if (!this.stopping)
        await this.delay(PENDING_REFERENCE_POLICY.pollIntervalMs);
    }
  }

  private async claimDueBatch(): Promise<
    Array<{
      transactionId: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
      kind: string;
      leaseToken: string;
    }>
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
        return {
          transactionId: row.id,
          walletId: row.walletId,
          providerId: row.providerId,
          externalTransactionId: row.externalTransactionId,
          kind: row.kind,
          leaseToken,
        };
      });
      if (claimed.length > 0) await em.flush();
      return claimed;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
