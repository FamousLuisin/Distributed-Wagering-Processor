import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import config from '../../../database/mikro-orm.config.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../wallets/infrastructure/wallet.entity.js';
import { ProcessWager } from './process-wager.js';
import type { ProcessWagerResult } from './process-wager.types.js';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity.js';
import { WagerTransactionKind } from '../domain/wager-transaction.types.js';
import { OutboxMessageEntity } from '../../messaging/infrastructure/outbox-message.entity.js';
import { PendingReferenceWorker } from './pending-reference-worker.js';
import { Money } from '../../wallets/domain/money.js';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import { WalletApplicationService } from '../../wallets/application/wallet-application.service.js';

const walletIdsUnderTest = new Set<string>();

describe('Wagering transactions (PostgreSQL and HTTP)', () => {
  let orm: MikroORM;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await orm?.close(true);
  });

  afterEach(async () => {
    for (const walletId of walletIdsUnderTest) {
      await expectWalletBalanceToMatchLedger(orm, walletId);
    }
    walletIdsUnderTest.clear();
  });

  it('allows only one of two simultaneous R$ 80 bets against a R$ 100 wallet', async () => {
    const { walletId, playerId } = await createWallet(orm);

    const processWager = new ProcessWager(orm.em);
    const common = {
      providerId: 'integration-test',
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'concurrency-case',
      kind: WagerTransactionKind.Bet as const,
      money: { amount: '80.00', currency: 'BRL' },
    };

    const results = await Promise.all([
      processWager.execute({
        ...common,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      processWager.execute({
        ...common,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ]);

    const resultStatuses = results.map(({ status }) => status).sort();
    expect(resultStatuses).toEqual(['PROCESSED', 'REJECTED']);

    const readEm = orm.em.fork();
    const finalWallet = await readEm.findOneOrFail(WalletEntity, walletId);
    const transactions = await readEm.find(WagerTransactionEntity, {
      walletId,
    });
    const ledgerEntries = await readEm.find(WalletLedgerEntryEntity, {
      walletId,
    });

    expect(finalWallet.balance).toBe('20.00');
    expect(finalWallet.version).toBe(2);
    const bets = transactions.filter(({ kind }) => kind === 'BET');
    expect(bets).toHaveLength(2);
    expect(
      bets.filter(({ status }) => status === 'PROCESSED'),
    ).toHaveLength(1);
    expect(
      bets.filter(({ status }) => status === 'REJECTED'),
    ).toHaveLength(1);
    expect(ledgerEntries).toHaveLength(2);
    const debitEntries = ledgerEntries.filter(
      ({ direction }) => direction === LedgerDirection.Debit,
    );
    expect(debitEntries).toHaveLength(1);
    expect(debitEntries[0]).toMatchObject({
      direction: 'DEBIT',
      amount: '80.00',
      balanceBefore: '100.00',
      balanceAfter: '20.00',
    });
    expect(
      results.filter(({ status }) => status === 'PROCESSED')[0]?.balance,
    ).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(
      results.filter(({ status }) => status === 'REJECTED')[0]?.failureCode,
    ).toBe('INSUFFICIENT_FUNDS');
  });

  it('replays the original result for the same key without applying another debit', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const originalBet = makeBet({
      playerId,
      walletId,
      idempotencyKey: randomUUID(),
      externalTransactionId: randomUUID(),
      amount: '25.00',
    });

    const firstResponse = await postBet(baseUrl, originalBet);
    const firstResult = (await firstResponse.json()) as ProcessWagerResult;
    const laterResponse = await postBet(
      baseUrl,
      makeBet({
        playerId,
        walletId,
        idempotencyKey: randomUUID(),
        externalTransactionId: randomUUID(),
        amount: '10.00',
      }),
    );
    const laterResult = (await laterResponse.json()) as ProcessWagerResult;
    const replayResponse = await postBet(baseUrl, originalBet);
    const replayResult = (await replayResponse.json()) as ProcessWagerResult;

    expect(firstResponse.status).toBe(200);
    expect(laterResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(firstResult).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(laterResult.balance.amount).toBe('65.00');
    expect(replayResult).toEqual({
      ...firstResult,
      idempotentReplay: true,
    });

    const readEm = orm.em.fork();
    const wallet = await readEm.findOneOrFail(WalletEntity, walletId);
    expect(wallet.balance).toBe('65.00');
    expect(
      await readEm.count(WagerTransactionEntity, {
        walletId,
        idempotencyKey: originalBet.idempotencyKey,
      }),
    ).toBe(1);
    expect(
      await readEm.count(WalletLedgerEntryEntity, {
        walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(2);
  });

  it('rejects reuse of an idempotency key with a different payload without changing the wallet', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const originalBet = makeBet({
      playerId,
      walletId,
      idempotencyKey: randomUUID(),
      externalTransactionId: randomUUID(),
      amount: '25.00',
    });
    const firstResponse = await postBet(baseUrl, originalBet);
    expect(firstResponse.status).toBe(200);

    const conflictResponse = await postBet(baseUrl, {
      ...originalBet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(conflictResponse.status).toBe(409);
    expect(await conflictResponse.json()).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const readEm = orm.em.fork();
    const wallet = await readEm.findOneOrFail(WalletEntity, walletId);
    expect(wallet.balance).toBe('75.00');
    expect(
      await readEm.count(WagerTransactionEntity, {
        walletId,
        idempotencyKey: originalBet.idempotencyKey,
      }),
    ).toBe(1);
    expect(
      await readEm.count(WalletLedgerEntryEntity, {
        walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
  });

  it('retries a missing reference after it arrives and commits financial state and outbox events together', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const processWager = new ProcessWager(orm.em);
    const providerId = `pending-reference-${randomUUID()}`;
    const referenceExternalTransactionId = randomUUID();
    const pending = await processWager.execute({
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'pending-reference-recovery',
      kind: WagerTransactionKind.Win,
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId,
    });

    expect(pending.status).toBe('PENDING_REFERENCE');
    const em = orm.em.fork({ clear: true });
    const pendingRow = await em.findOneOrFail(WagerTransactionEntity, {
      id: pending.transactionId,
    });
    expect(pendingRow.pendingReferenceNextAttemptAt).toBeInstanceOf(Date);
    expect(pendingRow.pendingReferenceExpiresAt).toBeInstanceOf(Date);

    await processWager.execute({
      providerId,
      externalTransactionId: referenceExternalTransactionId,
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId: pendingRow.roundId,
      gameId: 'pending-reference-recovery',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    pendingRow.pendingReferenceNextAttemptAt = new Date(Date.now() - 1_000);
    pendingRow.pendingReferenceLeaseToken = randomUUID();
    pendingRow.pendingReferenceLeaseUntil = new Date(Date.now() - 1_000);
    await em.flush();

    await waitUntil(async () => {
      const readEm = orm.em.fork({ clear: true });
      const wager = await readEm.findOneOrFail(WagerTransactionEntity, {
        id: pending.transactionId,
      });
      return wager.status === 'PROCESSED';
    });

    const verifyEm = orm.em.fork({ clear: true });
    const wager = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: pending.transactionId,
    });
    const wallet = await verifyEm.findOneOrFail(WalletEntity, walletId);
    expect(wager.pendingReferenceAttempts).toBeGreaterThan(0);
    expect(wager.pendingReferenceLeaseToken).toBeNull();
    expect(wager.pendingReferenceLeaseUntil).toBeNull();
    expect(wallet.balance).toBe('105.00');
    expect(
      await verifyEm.count(WalletLedgerEntryEntity, {
        transactionId: pending.transactionId,
        direction: 'CREDIT',
      }),
    ).toBe(1);
    expect(
      await verifyEm.count(OutboxMessageEntity, {
        aggregateId: pending.transactionId,
        eventType: 'WagerTransactionProcessed',
      }),
    ).toBe(1);
    expect(
      await verifyEm.count(OutboxMessageEntity, {
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
      }),
    ).toBe(3);
  }, 20_000);

  it('rejects a reference that remains missing after attempts expire', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const processWager = new ProcessWager(orm.em);
    const pending = await processWager.execute({
      providerId: `pending-reference-expiry-${randomUUID()}`,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'pending-reference-expiry',
      kind: WagerTransactionKind.Win,
      money: { amount: '15.00', currency: 'BRL' },
      referenceExternalTransactionId: randomUUID(),
    });
    expect(pending.status).toBe('PENDING_REFERENCE');

    const em = orm.em.fork({ clear: true });
    const row = await em.findOneOrFail(WagerTransactionEntity, {
      id: pending.transactionId,
    });
    row.pendingReferenceAttempts = 7;
    row.pendingReferenceNextAttemptAt = new Date(Date.now() - 2_000);
    row.pendingReferenceExpiresAt = new Date(Date.now() - 1_000);
    row.pendingReferenceLeaseToken = randomUUID();
    row.pendingReferenceLeaseUntil = new Date(Date.now() - 1_000);
    await em.flush();

    await waitUntil(async () => {
      const readEm = orm.em.fork({ clear: true });
      const wager = await readEm.findOneOrFail(WagerTransactionEntity, {
        id: pending.transactionId,
      });
      return wager.status === 'REJECTED';
    });

    const verifyEm = orm.em.fork({ clear: true });
    const wager = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: pending.transactionId,
    });
    const wallet = await verifyEm.findOneOrFail(WalletEntity, walletId);
    expect(wager.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(wallet.balance).toBe('100.00');
    expect(
      await verifyEm.count(WalletLedgerEntryEntity, {
        transactionId: pending.transactionId,
      }),
    ).toBe(0);
    expect(
      await verifyEm.count(OutboxMessageEntity, {
        aggregateId: pending.transactionId,
        eventType: 'WagerTransactionRejected',
      }),
    ).toBe(1);
  }, 20_000);

  it('lets competing workers recover an abandoned lease without double-processing', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const processWager = new ProcessWager(orm.em);
    const extraWorker = new PendingReferenceWorker(orm.em, processWager);
    extraWorker.onApplicationBootstrap();
    try {
      const providerId = `pending-reference-race-${randomUUID()}`;
      const referenceExternalTransactionId = randomUUID();
      const pending = await processWager.execute({
        providerId,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId,
        walletId,
        roundId: randomUUID(),
        gameId: 'pending-reference-race',
        kind: WagerTransactionKind.Win,
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId,
      });
      const pendingEm = orm.em.fork({ clear: true });
      const pendingRow = await pendingEm.findOneOrFail(
        WagerTransactionEntity,
        { id: pending.transactionId },
      );
      await processWager.execute({
        providerId,
        externalTransactionId: referenceExternalTransactionId,
        idempotencyKey: randomUUID(),
        playerId,
        walletId,
        roundId: pendingRow.roundId,
        gameId: 'pending-reference-race',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      });
      pendingRow.pendingReferenceNextAttemptAt = new Date(Date.now() - 1_000);
      pendingRow.pendingReferenceLeaseToken = randomUUID();
      pendingRow.pendingReferenceLeaseUntil = new Date(Date.now() - 1_000);
      await pendingEm.flush();

      await waitUntil(async () => {
        const readEm = orm.em.fork({ clear: true });
        const wager = await readEm.findOneOrFail(WagerTransactionEntity, {
          id: pending.transactionId,
        });
        return wager.status === 'PROCESSED';
      });

      const verifyEm = orm.em.fork({ clear: true });
      expect(
        await verifyEm.count(WalletLedgerEntryEntity, {
          transactionId: pending.transactionId,
        }),
      ).toBe(1);
      expect(
        await verifyEm.count(OutboxMessageEntity, {
          aggregateId: pending.transactionId,
          eventType: 'WagerTransactionProcessed',
        }),
      ).toBe(1);
      expect((await verifyEm.findOneOrFail(WalletEntity, walletId)).balance).toBe(
        '105.00',
      );
    } finally {
      await extraWorker.onModuleDestroy();
    }
  }, 20_000);

  it('applies one debit when the same wager is submitted 50 times concurrently', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const wager = {
      providerId: 'fifty-way-race',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'fifty-way-race',
      kind: WagerTransactionKind.Bet as const,
      money: { amount: '10.00', currency: 'BRL' },
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        new ProcessWager(orm.em.fork({ clear: true })).execute(wager),
      ),
    );

    expect(results).toHaveLength(50);
    expect(results.every(({ status }) => status === 'PROCESSED')).toBe(true);
    expect(results.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map(({ transactionId }) => transactionId)).size).toBe(1);

    const readEm = orm.em.fork({ clear: true });
    expect((await readEm.findOneOrFail(WalletEntity, walletId)).balance).toBe('90.00');
    expect(
      await readEm.count(WagerTransactionEntity, {
        walletId,
        idempotencyKey: wager.idempotencyKey,
      }),
    ).toBe(1);
    expect(
      await readEm.count(WalletLedgerEntryEntity, {
        walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
  }, 40_000);

  it('processes different wallets in parallel without serializing them globally', async () => {
    const work = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const { walletId, playerId } = await createWallet(orm);
        return {
          walletId,
          operation: new ProcessWager(orm.em.fork({ clear: true })).execute({
            providerId: 'parallel-wallets',
            externalTransactionId: randomUUID(),
            idempotencyKey: randomUUID(),
            playerId,
            walletId,
            roundId: randomUUID(),
            gameId: 'parallel-wallets',
            kind: WagerTransactionKind.Bet,
            money: { amount: '10.00', currency: 'BRL' },
          }),
        };
      }),
    );
    const results = await Promise.all(work.map(({ operation }) => operation));
    expect(results.every(({ status }) => status === 'PROCESSED')).toBe(true);

    const readEm = orm.em.fork({ clear: true });
    for (const { walletId } of work) {
      expect((await readEm.findOneOrFail(WalletEntity, walletId)).balance).toBe(
        '90.00',
      );
      expect(await readEm.count(WalletLedgerEntryEntity, { walletId })).toBe(2);
    }
  }, 30_000);

  it('keeps one financial effect across three independent Nest application instances', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const wager = makeBet({
      playerId,
      walletId,
      idempotencyKey: randomUUID(),
      externalTransactionId: randomUUID(),
      amount: '10.00',
    });
    const secondApp = await NestFactory.create(AppModule, { logger: false });
    const thirdApp = await NestFactory.create(AppModule, { logger: false });
    try {
      await Promise.all([
        secondApp.listen(0, '127.0.0.1'),
        thirdApp.listen(0, '127.0.0.1'),
      ]);
      const secondAddress = secondApp.getHttpServer().address() as AddressInfo;
      const thirdAddress = thirdApp.getHttpServer().address() as AddressInfo;
      const urls = [
        baseUrl,
        `http://127.0.0.1:${secondAddress.port}`,
        `http://127.0.0.1:${thirdAddress.port}`,
      ];
      const responses = await Promise.all(urls.map((url) => postBet(url, wager)));
      const results = await Promise.all(
        responses.map((response) => response.json() as Promise<ProcessWagerResult>),
      );

      expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
      expect(results.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map(({ transactionId }) => transactionId)).size).toBe(1);
      const readEm = orm.em.fork({ clear: true });
      expect((await readEm.findOneOrFail(WalletEntity, walletId)).balance).toBe(
        '90.00',
      );
      expect(
        await readEm.count(WagerTransactionEntity, {
          walletId,
          idempotencyKey: wager.idempotencyKey,
        }),
      ).toBe(1);
      expect(
        await readEm.count(WalletLedgerEntryEntity, {
          walletId,
          direction: LedgerDirection.Debit,
        }),
      ).toBe(1);
    } finally {
      await Promise.all([secondApp.close(), thirdApp.close()]);
    }
  }, 40_000);

  it('processes REFUND and ROLLBACK that both arrived before their referenced bet', async () => {
    const { walletId, playerId } = await createWallet(orm);
    const processWager = new ProcessWager(orm.em);
    const providerId = `out-of-order-reversals-${randomUUID()}`;
    const roundId = randomUUID();
    const referencedExternalId = randomUUID();
    const reversalKinds = [
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ] as const;
    const reversals = await Promise.all(
      reversalKinds.map((kind) =>
        processWager.execute({
          providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          playerId,
          walletId,
          roundId,
          gameId: 'out-of-order-reversals',
          kind,
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: referencedExternalId,
        }),
      ),
    );
    expect(reversals.map(({ status }) => status)).toEqual([
      'PENDING_REFERENCE',
      'PENDING_REFERENCE',
    ]);

    await processWager.execute({
      providerId,
      externalTransactionId: referencedExternalId,
      idempotencyKey: randomUUID(),
      playerId,
      walletId,
      roundId,
      gameId: 'out-of-order-reversals',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    const pendingEm = orm.em.fork({ clear: true });
    const pendingRows = await pendingEm.find(WagerTransactionEntity, {
      id: { $in: reversals.map(({ transactionId }) => transactionId) },
    });
    for (const row of pendingRows) {
      row.pendingReferenceNextAttemptAt = new Date(Date.now() - 1_000);
      row.pendingReferenceLeaseToken = null;
      row.pendingReferenceLeaseUntil = null;
    }
    await pendingEm.flush();

    await waitUntil(async () => {
      const readEm = orm.em.fork({ clear: true });
      const remaining = await readEm.count(WagerTransactionEntity, {
        id: { $in: reversals.map(({ transactionId }) => transactionId) },
        status: 'PENDING_REFERENCE',
      });
      return remaining === 0;
    });

    const readEm = orm.em.fork({ clear: true });
    const resolved = await readEm.find(WagerTransactionEntity, {
      id: { $in: reversals.map(({ transactionId }) => transactionId) },
    });
    expect(resolved.map(({ status }) => status)).toEqual([
      'PROCESSED',
      'PROCESSED',
    ]);
    expect((await readEm.findOneOrFail(WalletEntity, walletId)).balance).toBe(
      '110.00',
    );
    expect(
      await readEm.count(WalletLedgerEntryEntity, {
        walletId,
        direction: LedgerDirection.Credit,
      }),
    ).toBe(3);
    expect(await readEm.count(WalletLedgerEntryEntity, { walletId })).toBe(4);
  }, 25_000);
});

async function createWallet(
  orm: MikroORM,
): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const created = await new WalletApplicationService(
    orm.em.fork({ clear: true }),
  ).create({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  walletIdsUnderTest.add(created.id);
  return { walletId: created.id, playerId };
}

function makeBet(props: {
  playerId: string;
  walletId: string;
  idempotencyKey: string;
  externalTransactionId: string;
  amount: string;
}) {
  return {
    providerId: 'integration-test',
    externalTransactionId: props.externalTransactionId,
    idempotencyKey: props.idempotencyKey,
    playerId: props.playerId,
    walletId: props.walletId,
    roundId: randomUUID(),
    gameId: 'idempotency-case',
    kind: WagerTransactionKind.Bet,
    money: { amount: props.amount, currency: 'BRL' },
  };
}

async function postBet(
  baseUrl: string,
  bet: ReturnType<typeof makeBet>,
): Promise<Response> {
  const { idempotencyKey, ...body } = bet;
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
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
  throw new Error('Timed out waiting for pending-reference worker result');
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
    const before = Money.from({
      amount: entry.balanceBefore,
      currency: entry.currency,
    });
    const after = Money.from({
      amount: entry.balanceAfter,
      currency: entry.currency,
    });
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
