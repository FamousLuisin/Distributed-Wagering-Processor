import { createHash, randomUUID } from 'node:crypto';
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.js';
import config from '../../../database/mikro-orm.config.js';
import { InboxMessageEntity } from '../infrastructure/inbox-message.entity.js';
import { OutboxMessageEntity } from '../infrastructure/outbox-message.entity.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WagerTransactionEntity } from '../../wagering/infrastructure/wager-transaction.entity.js';
import { WalletEntity } from '../../wallets/infrastructure/wallet.entity.js';
import { WalletApplicationService } from '../../wallets/application/wallet-application.service.js';
import { Money } from '../../wallets/domain/money.js';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import { ProcessWager } from '../../wagering/application/process-wager.js';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.types.js';
import { OutboxPublisher } from './outbox-publisher.js';

const endpoint = 'http://localhost:4566';
const account = '000000000000';
const queueUrl = `${endpoint}/${account}/wager-transactions.fifo`;
const dlqUrl = `${endpoint}/${account}/wager-transactions-dlq.fifo`;
const eventsUrl = `${endpoint}/${account}/wager-events.fifo`;
const consumerName = 'wager-transaction-consumer';
const walletIdsUnderTest = new Set<string>();

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

  afterEach(async () => {
    for (const walletId of walletIdsUnderTest) {
      await expectWalletBalanceToMatchLedger(orm, walletId);
    }
    walletIdsUnderTest.clear();
  });

  it('consumes, deduplicates, publishes outbox events, and dead-letters invalid messages', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();

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
        publishedWalletEvents >= 2
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
    expect(ledgerRows).toBe(2);

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

  it('retries a transient consumer failure and processes the redelivered message once', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'messaging-retry-integration-test',
        externalTransactionId,
        idempotencyKey: `retry-test:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'messaging-retry-integration-test',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    const body = JSON.stringify(envelope);
    const processWager = app!.get(ProcessWager);
    const executeSpy = vi
      .spyOn(processWager, 'execute')
      .mockRejectedValueOnce(new Error('temporary database outage'));

    await sendInput(body, walletId, randomUUID());
    try {
      await waitUntil(inputQueueIsDrained, 20_000);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      const readEm = orm.em.fork({ clear: true });
      expect(
        await readEm.count(InboxMessageEntity, {
          consumerName,
          messageId,
        }),
      ).toBe(1);
      expect(
        await readEm.count(WalletLedgerEntryEntity, {
          walletId,
          direction: 'DEBIT',
        }),
      ).toBe(1);
      expect((await readEm.findOneOrFail(WalletEntity, walletId)).balance).toBe(
        '90.00',
      );
    } finally {
      executeSpy.mockRestore();
    }
  }, 25_000);

  it('allows concurrent publishers to claim and publish committed outbox events', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const publishers = Array.from({ length: 2 }, () =>
      new OutboxPublisher(
        orm.em.fork({ clear: true }),
        new SQSClient({
          endpoint,
          region: 'us-east-1',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          maxAttempts: 1,
        }),
      ),
    );
    publishers.forEach((publisher) => publisher.onApplicationBootstrap());
    try {
      const result = await app!.get(ProcessWager).execute({
        providerId: 'concurrent-publishers-integration-test',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'concurrent-publishers',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      });

      await waitUntil(async () => {
        const readEm = orm.em.fork({ clear: true });
        const transactionEvent = await readEm.findOne(OutboxMessageEntity, {
          aggregateId: result.transactionId,
          eventType: 'WagerTransactionProcessed',
        });
        const balanceEvents = await readEm.find(OutboxMessageEntity, {
          aggregateId: walletId,
          eventType: 'WalletBalanceChanged',
        });
        const transactionBalanceEvent = balanceEvents.find((message) => {
          const data = message.payload.data as { transactionId?: string };
          return data.transactionId === result.transactionId;
        });
        return (
          transactionEvent?.publishedAt !== null &&
          transactionEvent?.publishedAt !== undefined &&
          transactionBalanceEvent?.publishedAt !== null &&
          transactionBalanceEvent?.publishedAt !== undefined
        );
      });

      const readEm = orm.em.fork({ clear: true });
      const transactionEvent = await readEm.findOneOrFail(OutboxMessageEntity, {
        aggregateId: result.transactionId,
        eventType: 'WagerTransactionProcessed',
      });
      const balanceEvent = (await readEm.find(OutboxMessageEntity, {
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
      })).find((message) => {
        const data = message.payload.data as { transactionId?: string };
        return data.transactionId === result.transactionId;
      });
      expect(transactionEvent.attempts).toBe(0);
      expect(balanceEvent?.attempts).toBe(0);
      expect(transactionEvent.leaseToken).toBeNull();
      expect(balanceEvent?.leaseToken).toBeNull();
      expect(
        await receivePublishedEventTypes(result.transactionId, walletId),
      ).toEqual(expect.arrayContaining([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]));
    } finally {
      await Promise.all(publishers.map((publisher) => publisher.onModuleDestroy()));
    }
  }, 30_000);

  it('recovers committed inbox and outbox work after an application restart', async () => {
    const closingApp = app;
    app = undefined;
    await closingApp?.close();

    const { walletId, playerId } = await createWallet(orm);
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const data = {
      providerId: 'restart-recovery-integration-test',
      externalTransactionId,
      idempotencyKey: `restart-test:${externalTransactionId}`,
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'restart-recovery',
      kind: WagerTransactionKind.Bet as const,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data,
    };
    const body = JSON.stringify(envelope);
    const payloadHash = createHash('sha256').update(body).digest('hex');

    // Commit the financial work and inbox, then simulate a process death before DeleteMessage.
    await new ProcessWager(orm.em.fork({ clear: true })).execute({
      ...data,
      correlationId: messageId,
      causationId: messageId,
      inboxMessage: {
        messageId,
        consumerName,
        payloadHash,
      },
    });
    await sendInput(body, walletId, randomUUID());

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    await waitUntil(async () => {
      if (!(await inputQueueIsDrained())) return false;
      const readEm = orm.em.fork({ clear: true });
      const wager = await readEm.findOne(WagerTransactionEntity, {
        providerId: data.providerId,
        externalTransactionId,
      });
      if (!wager) return false;
      const unpublished = await readEm.count(OutboxMessageEntity, {
        $or: [
          { aggregateId: wager.id, publishedAt: null },
          { aggregateId: walletId, publishedAt: null },
        ],
      });
      return unpublished === 0;
    }, 20_000);

    const readEm = orm.em.fork({ clear: true });
    expect(
      await readEm.count(InboxMessageEntity, {
        consumerName,
        messageId,
      }),
    ).toBe(1);
    expect(
      await readEm.count(WalletLedgerEntryEntity, {
        walletId,
        transactionId: (await readEm.findOneOrFail(WagerTransactionEntity, {
          providerId: data.providerId,
          externalTransactionId,
        })).id,
      }),
    ).toBe(1);
    expect((await readEm.findOneOrFail(WalletEntity, walletId)).balance).toBe(
      '90.00',
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
): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const wallet = await new WalletApplicationService(
    orm.em.fork({ clear: true }),
  ).create({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  walletIdsUnderTest.add(wallet.id);
  return { walletId: wallet.id, playerId };
}

async function expectWalletBalanceToMatchLedger(
  orm: MikroORM,
  walletId: string,
): Promise<void> {
  const em = orm.em.fork({ clear: true });
  const wallet = await em.findOneOrFail(WalletEntity, walletId);
  const entries = await em.find(WalletLedgerEntryEntity, { walletId });
  let calculated = Money.zero(wallet.currency);
  for (const entry of entries) {
    const amount = Money.from({ amount: entry.amount, currency: entry.currency });
    const before = Money.from({ amount: entry.balanceBefore, currency: entry.currency });
    const after = Money.from({ amount: entry.balanceAfter, currency: entry.currency });
    if (entry.direction === LedgerDirection.Credit) {
      expect(after.equals(before.add(amount))).toBe(true);
      calculated = calculated.add(amount);
    } else {
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(after.equals(before.subtract(amount))).toBe(true);
      calculated = calculated.subtract(amount);
    }
  }
  expect(calculated.toJSON()).toEqual({
    amount: wallet.balance,
    currency: wallet.currency,
  });
}
