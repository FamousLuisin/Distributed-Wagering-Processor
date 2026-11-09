import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { LockMode, QueryOrder } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { OutboxMessage } from '../domain/outbox-message.js';
import { OutboxMessageEntity } from '../infrastructure/outbox-message.entity.js';
import { SQS_CLIENT } from '../infrastructure/sqs-client.provider.js';
import { MetricsService } from '../../../shared/observability/metrics.service.js';
import { logEvent } from '../../../shared/observability/structured-log.js';

interface ClaimedOutboxMessage {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: Date;
  occurredAt: Date;
  createdAt: Date;
  leaseToken: string;
}

@Injectable()
export class OutboxPublisher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private static readonly BATCH_SIZE = 10;
  private static readonly LEASE_DURATION_MS = 60_000;
  private static readonly POLL_INTERVAL_MS = 1_000;
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly queueUrl = process.env.SQS_EVENTS_QUEUE_URL?.trim();
  private stopping = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly metrics: MetricsService = new MetricsService(),
  ) {
    if (this.queueUrl && !this.queueUrl.endsWith('.fifo')) {
      throw new Error('SQS_EVENTS_QUEUE_URL must point to a FIFO queue');
    }
  }

  onApplicationBootstrap(): void {
    if (!this.queueUrl) {
      logEvent(
        this.logger,
        'warn',
        OutboxPublisher.name,
        'outbox_publisher_disabled',
        {
          errorCode: 'SQS_EVENTS_QUEUE_URL_NOT_CONFIGURED',
        },
      );
      return;
    }
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loopPromise;
    this.sqs.destroy();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.refreshOutboxMetrics();
        const messages = await this.claimBatch();
        if (messages.length > 0) {
          await Promise.allSettled(
            messages.map((message) => this.publishOne(message)),
          );
          continue;
        }
      } catch (error) {
        logEvent(
          this.logger,
          'error',
          OutboxPublisher.name,
          'outbox_poll_failed',
          {
            errorCode: this.errorName(error),
          },
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, OutboxPublisher.POLL_INTERVAL_MS),
      );
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxMessage[]> {
    const em = this.em.fork({ clear: true });
    return em.transactional(async (transactionalEm) => {
      const now = new Date();
      const rows = await transactionalEm.find(
        OutboxMessageEntity,
        {
          publishedAt: null,
          nextAttemptAt: { $lte: now },
          $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
        },
        {
          orderBy: { createdAt: QueryOrder.ASC },
          limit: OutboxPublisher.BATCH_SIZE,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );

      const leaseUntil = new Date(
        now.getTime() + OutboxPublisher.LEASE_DURATION_MS,
      );
      const claimed = rows.map((row) => {
        const leaseToken = randomUUID();
        row.leaseToken = leaseToken;
        row.leaseUntil = leaseUntil;
        return {
          id: row.id,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: row.payload,
          attempts: row.attempts,
          nextAttemptAt: row.nextAttemptAt,
          occurredAt: row.occurredAt,
          createdAt: row.createdAt,
          leaseToken,
        };
      });
      if (claimed.length > 0) await transactionalEm.flush();
      return claimed;
    });
  }

  private async publishOne(message: ClaimedOutboxMessage): Promise<void> {
    const queueUrl = this.queueUrl;
    if (!queueUrl) return;
    const startedAt = Date.now();
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: message.eventType },
            eventId: { DataType: 'String', StringValue: message.id },
          },
        }),
      );

      const em = this.em.fork({ clear: true });
      const updated = await em.nativeUpdate(
        OutboxMessageEntity,
        {
          id: message.id,
          leaseToken: message.leaseToken,
          publishedAt: null,
        },
        {
          publishedAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
        },
      );
      if (updated === 0) {
        logEvent(
          this.logger,
          'warn',
          OutboxPublisher.name,
          'outbox_publish_lease_lost',
          {
            ...this.eventLogContext(message),
            messageId: message.id,
            eventId: message.id,
            eventType: message.eventType,
          },
        );
        return;
      }
      this.metrics.increment(
        'outbox_events_published_total',
        'Events successfully published from the transactional outbox.',
        { event_type: message.eventType },
      );
      logEvent(
        this.logger,
        'log',
        OutboxPublisher.name,
        'outbox_event_published',
        {
          ...this.eventLogContext(message),
          messageId: message.id,
          eventId: message.id,
          eventType: message.eventType,
          durationMs: Date.now() - startedAt,
        },
      );
    } catch (error) {
      try {
        await this.scheduleRetry(message, error);
      } catch (retryError) {
        logEvent(
          this.logger,
          'error',
          OutboxPublisher.name,
          'outbox_retry_persist_failed',
          {
            ...this.eventLogContext(message),
            messageId: message.id,
            eventId: message.id,
            errorCode: this.errorName(retryError),
          },
        );
      }
    } finally {
      this.metrics.observe(
        'outbox_publish_duration_seconds',
        'Time spent publishing a committed outbox event to SQS.',
        (Date.now() - startedAt) / 1_000,
        { event_type: message.eventType },
      );
    }
  }

  private async scheduleRetry(
    message: ClaimedOutboxMessage,
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    const domainMessage = OutboxMessage.rehydrate({
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      createdAt: message.createdAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
    });
    const errorCode = this.errorName(error);
    domainMessage.scheduleRetry(now, errorCode);
    this.metrics.increment(
      'messaging_retries_total',
      'Retry attempts scheduled by asynchronous messaging components.',
      { component: 'outbox_publisher' },
    );

    const em = this.em.fork({ clear: true });
    const updated = await em.nativeUpdate(
      OutboxMessageEntity,
      {
        id: message.id,
        leaseToken: message.leaseToken,
        publishedAt: null,
      },
      {
        attempts: domainMessage.attempts,
        nextAttemptAt: domainMessage.nextAttemptAt,
        leaseToken: null,
        leaseUntil: null,
        lastError: errorCode,
      },
    );
    logEvent(
      this.logger,
      'warn',
      OutboxPublisher.name,
      updated > 0 ? 'outbox_retry_scheduled' : 'outbox_retry_lease_lost',
      {
        ...this.eventLogContext(message),
        messageId: message.id,
        eventId: message.id,
        attempt: domainMessage.attempts,
        nextAttemptAt: domainMessage.nextAttemptAt.toISOString(),
        errorCode,
      },
    );
  }

  private async refreshOutboxMetrics(): Promise<void> {
    const em = this.em.fork({ clear: true });
    const pending = await em.find(
      OutboxMessageEntity,
      { publishedAt: null },
      {
        orderBy: { createdAt: QueryOrder.ASC },
        limit: 1,
        fields: ['createdAt'],
      },
    );
    const pendingCount = await em.count(OutboxMessageEntity, {
      publishedAt: null,
    });
    const oldestCreatedAt = pending[0]?.createdAt.getTime();
    this.metrics.setGauge(
      'outbox_pending_messages',
      'Number of outbox events not yet marked as published.',
      pendingCount,
    );
    this.metrics.setGauge(
      'outbox_oldest_unpublished_seconds',
      'Age of the oldest unpublished outbox event in seconds.',
      oldestCreatedAt === undefined
        ? 0
        : Math.max(0, (Date.now() - oldestCreatedAt) / 1_000),
    );
  }

  private eventLogContext(message: ClaimedOutboxMessage) {
    const data = message.payload.data;
    const fields =
      typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>)
        : {};
    const asString = (value: unknown) =>
      typeof value === 'string' ? value : undefined;
    return {
      correlationId: asString(fields.correlationId),
      causationId: asString(fields.causationId),
      transactionId: asString(fields.transactionId),
      walletId: asString(fields.walletId),
      providerId: asString(fields.providerId),
      externalTransactionId: asString(fields.externalTransactionId),
    };
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name.slice(0, 128) : 'UnknownError';
  }
}
