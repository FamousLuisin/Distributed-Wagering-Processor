import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQS_CLIENT } from '../../messaging/infrastructure/sqs-client.provider.js';
import { MetricsService } from '../../../shared/observability/metrics.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly metrics: MetricsService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() response: Response): Promise<void> {
    const [postgres, sqs] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);
    const ready = postgres.status === 'ok' && sqs.status === 'ok';
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    });
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metricsEndpoint(): string {
    return this.metrics.renderPrometheus();
  }

  private async checkPostgres(): Promise<{
    status: 'ok' | 'error';
    error?: string;
  }> {
    try {
      await this.withTimeout(
        this.em.getConnection().execute('select 1'),
        3_000,
      );
      return { status: 'ok' };
    } catch (error) {
      return { status: 'error', error: this.errorName(error) };
    }
  }

  private async checkSqs(): Promise<{
    status: 'ok' | 'error';
    queues?: Record<string, 'ok' | 'error'>;
    error?: string;
  }> {
    const configuredQueues = {
      transactions: process.env.SQS_TRANSACTIONS_QUEUE_URL?.trim(),
      deadLetter: process.env.SQS_TRANSACTIONS_DLQ_QUEUE_URL?.trim(),
      events: process.env.SQS_EVENTS_QUEUE_URL?.trim(),
    };
    const missing = Object.entries(configuredQueues)
      .filter(([, url]) => !url)
      .map(([name]) => name);
    if (missing.length > 0) {
      return {
        status: 'error',
        error: `queues_not_configured:${missing.join(',')}`,
      };
    }

    const queues = Object.fromEntries(
      await Promise.all(
        Object.entries(configuredQueues).map(async ([name, url]) => {
          try {
            await this.sqs.send(
              new GetQueueAttributesCommand({
                QueueUrl: url,
                AttributeNames: ['QueueArn'],
              }),
              { abortSignal: AbortSignal.timeout(3_000) },
            );
            return [name, 'ok'] as const;
          } catch {
            return [name, 'error'] as const;
          }
        }),
      ),
    ) as Record<string, 'ok' | 'error'>;
    const status = Object.values(queues).every((queue) => queue === 'ok')
      ? 'ok'
      : 'error';
    return { status, queues };
  }

  private errorName(error: unknown): string {
    if (!(error instanceof Error)) return 'UnknownError';
    return error.message === 'ProbeTimeout' ? 'ProbeTimeout' : error.name;
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('ProbeTimeout')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
