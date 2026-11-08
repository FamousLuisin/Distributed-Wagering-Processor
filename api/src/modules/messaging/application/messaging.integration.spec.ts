import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import config from '../../../database/mikro-orm.config.js';
import { InboxMessageEntity } from '../infrastructure/inbox-message.entity.js';
import { OutboxMessageEntity } from '../infrastructure/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.entity.js';
import { WalletEntity } from '../../wallets/infrastructure/wallet.entity.js';

const endpoint = 'http://localhost:4566';
const account = '000000000000';
const queueUrl = `${endpoint}/${account}/wager-transactions.fifo`;
const dlqUrl = `${endpoint}/${account}/wager-transactions-dlq.fifo`;
const eventsUrl = `${endpoint}/${account}/wager-events.fifo`;
const consumerName = 'wager-transaction-consumer';

describe('Messaging integration (PostgreSQL and LocalStack)', () => {
  let orm: MikroORM;
  let app: INestApplication | undefined;
  let sqs: SQSClient;

  beforeAll(async () => {
    process.env.SQS_ENDPOINT = endpoint;
    process.env.SQS_TRANSACTIONS_QUEUE_URL = queueUrl;
    process.env.SQS_TRANSACTIONS_DLQ_QUEUE_URL = dlqUrl;
    process.env.SQS_EVENTS_QUEUE_URL = eventsUrl;
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';

    sqs = new SQSClient({
      endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    sqs?.destroy();
    await orm?.close(true);
  }, 30_000);

  it('consumes, deduplicates, publishes outbox events, and dead-letters invalid messages', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    await createWallet(orm, walletId, playerId);

    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'messaging-integration-test',
        externalTransactionId,
        idempotencyKey: `messaging-test:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'messaging-integration-test',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    const body = JSON.stringify(envelope);

    await sendInput(body, walletId, randomUUID());
    await sendInput(body, walletId, randomUUID());

    await waitUntil(async () => {
      const em = orm.em.fork({ clear: true });
      const inbox = await em.findOne(InboxMessageEntity, {
        consumerName,
        messageId,
      });
      const wager = await em.findOne(WagerTransactionEntity, {
        providerId: 'messaging-integration-test',
        externalTransactionId,
      });
      const publishedWagerEvents = await em.count(OutboxMessageEntity, {
        aggregateId: wager?.id,
        publishedAt: { $ne: null },
      });
      const publishedWalletEvents = await em.count(OutboxMessageEntity, {
        aggregateId: walletId,
        publishedAt: { $ne: null },
      });
      return (
        inbox?.processedAt !== undefined &&
        wager?.status === 'PROCESSED' &&
        publishedWagerEvents >= 1 &&
        publishedWalletEvents >= 1
      );
    });
    await waitUntil(inputQueueIsDrained);

    const readEm = orm.em.fork({ clear: true });
    const wallet = await readEm.findOneOrFail(WalletEntity, walletId);
    const wager = await readEm.findOneOrFail(WagerTransactionEntity, {
      providerId: 'messaging-integration-test',
      externalTransactionId,
    });
    const inboxRows = await readEm.count(InboxMessageEntity, {
      consumerName,
      messageId,
    });
    const ledgerRows = await readEm.count(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(wallet.balance).toBe('90.00');
    expect(inboxRows).toBe(1);
    expect(ledgerRows).toBe(1);

    const publishedEventTypes = await receivePublishedEventTypes(wager.id, walletId);
    expect(publishedEventTypes).toContain('WagerTransactionProcessed');
    expect(publishedEventTypes).toContain('WalletBalanceChanged');

    const invalidBody = `not-json-${randomUUID()}`;
    await sendInput(invalidBody, randomUUID(), randomUUID());
    const deadLetter = await waitForDeadLetter(invalidBody);
    expect(deadLetter.MessageAttributes?.failureCode?.StringValue).toBe(
      'InvalidQueueMessageError',
    );
  }, 30_000);

  it('waits for the long-poll loop to stop cleanly on application shutdown', async () => {
    const closingApp = app;
    app = undefined;
    const startedAt = Date.now();
    await closingApp?.close();
    expect(Date.now() - startedAt).toBeLessThan(25_000);
  }, 30_000);

  async function sendInput(body: string, groupId: string, deduplicationId: string) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async function inputQueueIsDrained(): Promise<boolean> {
    const response = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      response.Attributes?.ApproximateNumberOfMessages === '0' &&
      response.Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
    );
  }

  async function receivePublishedEventTypes(
    transactionId: string,
    walletId: string,
  ): Promise<string[]> {
    const found = new Set<string>();
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (!found.has('WagerTransactionProcessed') || !found.has('WalletBalanceChanged'))
    ) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: eventsUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
        }),
      );
      for (const message of response.Messages ?? []) {
        if (message.ReceiptHandle && message.Body) {
          const event = JSON.parse(message.Body) as {
            eventType?: string;
            aggregateId?: string;
            data?: { transactionId?: string; walletId?: string };
          };
          if (
            (event.data?.transactionId === transactionId ||
              (event.eventType === 'WalletBalanceChanged' &&
                event.data?.walletId === walletId)) &&
            event.eventType
          ) {
            found.add(event.eventType);
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: eventsUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          } else {
            await sqs.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: eventsUrl,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0,
              }),
            );
          }
        }
      }
    }
    return [...found];
  }

  async function waitForDeadLetter(body: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
        }),
      );
      for (const message of response.Messages ?? []) {
        if (message.Body === body) {
          if (message.ReceiptHandle) {
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: dlqUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
          return message;
        }
        if (message.ReceiptHandle) {
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        }
      }
    }
    throw new Error('Timed out waiting for invalid message in the DLQ');
  }

  async function waitUntil(
    predicate: () => Promise<boolean>,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for messaging integration result');
  }
});

async function createWallet(
  orm: MikroORM,
  walletId: string,
  playerId: string,
): Promise<void> {
  const now = new Date();
  const em = orm.em.fork();
  const wallet = new WalletEntity();
  Object.assign(wallet, {
    id: walletId,
    playerId,
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  em.persist(wallet);
  await em.flush();
}
