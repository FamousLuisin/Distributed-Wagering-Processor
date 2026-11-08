import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import config from '../../../database/mikro-orm.config.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../wallets/infrastructure/wallet.entity.js';
import { ProcessBet } from './process-bet.js';
import type { ProcessBetResult } from './process-bet.types.js';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity.js';

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

  it('allows only one of two simultaneous R$ 80 bets against a R$ 100 wallet', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const now = new Date();
    const setupEm = orm.em.fork();
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
    setupEm.persist(wallet);
    await setupEm.flush();
    setupEm.clear();

    const processBet = new ProcessBet(orm.em);
    const common = {
      providerId: 'integration-test',
      playerId,
      walletId,
      roundId: randomUUID(),
      gameId: 'concurrency-case',
      money: { amount: '80.00', currency: 'BRL' },
    };

    const results = await Promise.all([
      processBet.execute({
        ...common,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
      processBet.execute({
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
    expect(transactions).toHaveLength(2);
    expect(
      transactions.filter(({ status }) => status === 'PROCESSED'),
    ).toHaveLength(1);
    expect(
      transactions.filter(({ status }) => status === 'REJECTED'),
    ).toHaveLength(1);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
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
    const firstResult = (await firstResponse.json()) as ProcessBetResult;
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
    const laterResult = (await laterResponse.json()) as ProcessBetResult;
    const replayResponse = await postBet(baseUrl, originalBet);
    const replayResult = (await replayResponse.json()) as ProcessBetResult;

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
    expect(await readEm.count(WagerTransactionEntity, { walletId })).toBe(2);
    expect(await readEm.count(WalletLedgerEntryEntity, { walletId })).toBe(2);
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
    expect(await readEm.count(WagerTransactionEntity, { walletId })).toBe(1);
    expect(await readEm.count(WalletLedgerEntryEntity, { walletId })).toBe(1);
  });
});

async function createWallet(
  orm: MikroORM,
): Promise<{ walletId: string; playerId: string }> {
  const walletId = randomUUID();
  const playerId = randomUUID();
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
  return { walletId, playerId };
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
    body: JSON.stringify({ ...body, kind: 'BET' }),
  });
}
