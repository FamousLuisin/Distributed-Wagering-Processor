import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../../../database/mikro-orm.config.js';
import { WalletLedgerEntryEntity } from '../../ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../wallets/infrastructure/wallet.entity.js';
import { ProcessBet } from './process-bet.js';
import { WagerTransactionEntity } from '../infrastructure/wager-transaction.entity.js';

describe('ProcessBet concurrent wallet debit (PostgreSQL)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
  });

  afterAll(async () => {
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
    const transactions = await readEm.find(WagerTransactionEntity, { walletId });
    const ledgerEntries = await readEm.find(WalletLedgerEntryEntity, { walletId });

    expect(finalWallet.balance).toBe('20.00');
    expect(finalWallet.version).toBe(2);
    expect(transactions).toHaveLength(2);
    expect(transactions.filter(({ status }) => status === 'PROCESSED')).toHaveLength(1);
    expect(transactions.filter(({ status }) => status === 'REJECTED')).toHaveLength(1);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
      direction: 'DEBIT',
      amount: '80.00',
      balanceBefore: '100.00',
      balanceAfter: '20.00',
    });
    expect(results.filter(({ status }) => status === 'PROCESSED')[0]?.balance).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(results.filter(({ status }) => status === 'REJECTED')[0]?.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
  });
});
