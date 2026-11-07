import { describe, expect, it } from 'vitest';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import { Money } from '../../wallets/domain/money.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransactionReferenceError,
  InvalidWagerTransactionStateError,
  InvalidWagerTransactionTransitionError,
} from './wager-transaction.errors.js';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from './wager-transaction.types.js';
import { WagerTransaction } from './wager-transaction.js';

const now = new Date('2026-11-07T12:00:00.000Z');
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const transaction = (
  kind: CreateWagerTransactionProps['kind'] = Kind.Bet,
  extra: Partial<CreateWagerTransactionProps> = {},
) =>
  WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: money('10.00'),
    createdAt: now,
    ...extra,
  });

describe('WagerTransaction', () => {
  it('is created in PENDING and exposes the payload match check', () => {
    const bet = transaction();

    expect(bet.status).toBe(Status.Pending);
    expect(bet.isTerminal()).toBe(false);
    expect(bet.matchesPayload('hash-1')).toBe(true);
    expect(bet.matchesPayload('other-hash')).toBe(false);
  });

  it('requires an external reference for REFUND and ROLLBACK', () => {
    for (const kind of [Kind.Refund, Kind.Rollback] as const) {
      expect(() => transaction(kind)).toThrow(
        InvalidWagerTransactionReferenceError,
      );
      expect(
        transaction(kind, { referenceExternalTransactionId: 'external-ref' })
          .requiresReference(),
      ).toBe(true);
    }
  });

  it('allows an optional reference for WIN and no reference for BET/LOSS', () => {
    expect(transaction(Kind.Win).requiresReference()).toBe(false);
    expect(transaction(Kind.Loss).requiresReference()).toBe(false);
    expect(
      transaction(Kind.Win, { referenceExternalTransactionId: 'bet-1' })
        .referenceExternalTransactionId,
    ).toBe('bet-1');
  });

  it('rejects a negative amount', () => {
    expect(() => transaction(Kind.Bet, { money: money('1.00').negate() })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('does not allow external creation of OPENING and creates it through its internal factory', () => {
    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      providerId: 'internal',
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'opening-hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'opening',
      gameId: 'internal',
      money: money('10.00'),
      createdAt: now,
    });

    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Processed);
    expect(opening.processedAt).toEqual(now);
    expect(opening.isTerminal()).toBe(true);
  });

  it('moves a reference dependent operation to PENDING_REFERENCE and processes it later', () => {
    const refund = transaction(Kind.Refund, {
      referenceExternalTransactionId: 'bet-external-1',
    });

    refund.markPendingReference();
    expect(refund.status).toBe(Status.PendingReference);
    refund.markProcessed('bet-internal-1', now);
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe('bet-internal-1');
    expect(refund.processedAt).toEqual(now);
  });

  it('processes regular transactions and records an optional resolved reference', () => {
    const win = transaction(Kind.Win);
    win.markProcessed('bet-internal-1', now);

    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe('bet-internal-1');
  });

  it('rejects markProcessed when a required resolved reference is missing', () => {
    const refund = transaction(Kind.Refund, {
      referenceExternalTransactionId: 'bet-external-1',
    });

    expect(() => refund.markProcessed(undefined, now)).toThrow(
      InvalidWagerTransactionReferenceError,
    );
    expect(refund.status).toBe(Status.Pending);
  });

  it('rejects pending-reference transition for operations without required references', () => {
    expect(() => transaction(Kind.Bet).markPendingReference()).toThrow(
      InvalidWagerTransactionTransitionError,
    );
    const refund = transaction(Kind.Refund, {
      referenceExternalTransactionId: 'bet-external-1',
    });
    refund.markPendingReference();
    expect(() => refund.markPendingReference()).toThrow(
      InvalidWagerTransactionTransitionError,
    );
  });

  it('rejects/fails with stable failure codes and makes both terminal', () => {
    const rejected = transaction();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.isTerminal()).toBe(true);

    const failed = transaction(Kind.Win);
    failed.fail(FailureCode.PermanentInfrastructureFailure);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.PermanentInfrastructureFailure);
    expect(failed.isTerminal()).toBe(true);
  });

  it('does not allow transitions from terminal statuses', () => {
    const processed = transaction();
    processed.markProcessed(undefined, now);
    expect(() => processed.reject(FailureCode.InvalidOperation)).toThrow(
      InvalidWagerTransactionStateError,
    );

    const rejected = transaction();
    rejected.reject(FailureCode.InvalidOperation);
    expect(() => rejected.markProcessed(undefined, now)).toThrow(
      InvalidWagerTransactionStateError,
    );
  });

  it('classifies balance effects and ledger directions', () => {
    expect(transaction(Kind.Bet).affectsBalance()).toBe(true);
    expect(transaction(Kind.Loss).affectsBalance()).toBe(false);
    expect(transaction(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(transaction(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(transaction(Kind.Refund, { referenceExternalTransactionId: 'bet' }).ledgerDirectionFor(
      (() => {
        const bet = transaction(Kind.Bet);
        bet.markProcessed(undefined, now);
        return bet;
      })(),
    )).toBe(LedgerDirection.Credit);
    expect(() => transaction(Kind.Loss).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ] as const)('computes ROLLBACK as the inverse of reference kind %s', (kind, direction) => {
    const reference =
      kind === Kind.Refund
        ? transaction(kind, { referenceExternalTransactionId: 'bet' })
        : transaction(kind);
    if (kind === Kind.Refund) reference.markProcessed('bet-internal', now);
    else reference.markProcessed(undefined, now);

    const rollback = transaction(Kind.Rollback, {
      referenceExternalTransactionId: 'reference-external',
    });
    expect(rollback.ledgerDirectionFor(reference)).toBe(direction);
  });

  it('rejects ROLLBACK of an unsupported or unprocessed reference', () => {
    const rollback = transaction(Kind.Rollback, {
      referenceExternalTransactionId: 'reference',
    });
    expect(() => rollback.ledgerDirectionFor(transaction(Kind.Loss))).toThrow(
      InvalidWagerTransactionReferenceError,
    );
    const unprocessedBet = transaction(Kind.Bet);
    expect(() => rollback.ledgerDirectionFor(unprocessedBet)).toThrow(
      InvalidWagerTransactionReferenceError,
    );
  });

  it('rehydrates persisted status and defensively copies dates', () => {
    const pending = transaction();
    pending.markProcessed(undefined, now);
    const rehydrated = WagerTransaction.rehydrate({
      id: pending.id,
      providerId: pending.providerId,
      externalTransactionId: pending.externalTransactionId,
      idempotencyKey: pending.idempotencyKey,
      payloadHash: pending.payloadHash,
      walletId: pending.walletId,
      playerId: pending.playerId,
      roundId: pending.roundId,
      gameId: pending.gameId,
      kind: pending.kind,
      money: pending.money,
      referenceExternalTransactionId: pending.referenceExternalTransactionId,
      createdAt: pending.createdAt,
      status: pending.status,
      referenceTransactionId: pending.referenceTransactionId,
      failureCode: pending.failureCode,
      processedAt: pending.processedAt,
    });
    const date = rehydrated.processedAt!;
    date.setFullYear(2000);

    expect(rehydrated.status).toBe(Status.Processed);
    expect(rehydrated.processedAt).toEqual(now);
  });
});
