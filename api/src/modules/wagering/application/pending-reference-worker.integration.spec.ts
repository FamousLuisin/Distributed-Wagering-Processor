import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { ProcessWager } from './process-wager.js';
import { PendingReferenceWorker } from './pending-reference-worker.js';

describe('PendingReferenceWorker lifecycle', () => {
  it('waits for an already claimed transaction before shutting down', async () => {
    let finishProcessing!: () => void;
    const processing = new Promise<void>((resolve) => {
      finishProcessing = resolve;
    });
    const transaction = {
      id: 'pending-transaction',
      pendingReferenceLeaseToken: null,
      pendingReferenceLeaseUntil: null,
    };
    const transactionalEntityManager = {
      find: vi.fn().mockResolvedValue([transaction]),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const entityManager = {
      fork: vi.fn(() => entityManager),
      transactional: vi.fn((callback: (em: unknown) => unknown) =>
        callback(transactionalEntityManager),
      ),
    } as unknown as EntityManager;
    const processWager = {
      retryPendingReference: vi.fn(async () => {
        await processing;
        return 'processed' as const;
      }),
    } as unknown as ProcessWager;
    const worker = new PendingReferenceWorker(entityManager, processWager);

    worker.onApplicationBootstrap();
    await vi.waitFor(() => {
      expect(processWager.retryPendingReference).toHaveBeenCalledOnce();
    });

    let shutdownFinished = false;
    const shutdown = worker.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    finishProcessing();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
