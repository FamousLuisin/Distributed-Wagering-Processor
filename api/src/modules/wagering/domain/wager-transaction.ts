import type { Money } from '../../wallets/domain/money.js';
import { LedgerDirection } from '../../../shared/domain/ledger-direction.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateOpeningWagerTransactionProps,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from './wager-transaction.types.js';
import {
  InvalidWagerTransactionError,
  InvalidWagerTransactionReferenceError,
  InvalidWagerTransactionStateError,
  InvalidWagerTransactionTransitionError,
} from './wager-transaction.errors.js';

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if ((props.kind as WagerTransactionKind) === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING is internal; use createOpening() instead',
      );
    }
    WagerTransaction.validateCommon(props);
    WagerTransaction.validateReferenceRequirement(
      props.kind,
      props.referenceExternalTransactionId,
    );
    const createdAt = props.createdAt ?? new Date();
    WagerTransaction.assertDate(createdAt, 'createdAt');

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(createdAt.getTime()),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(
    props: CreateOpeningWagerTransactionProps,
  ): WagerTransaction {
    WagerTransaction.validateCommon(props);
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'Opening transaction amount must be positive',
      );
    }
    const createdAt = props.createdAt ?? new Date();
    WagerTransaction.assertDate(createdAt, 'createdAt');
    const timestamp = new Date(createdAt.getTime());

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      timestamp,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      new Date(timestamp.getTime()),
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    WagerTransaction.validateCommon(state);
    WagerTransaction.validateReferenceRequirement(
      state.kind,
      state.referenceExternalTransactionId,
    );
    WagerTransaction.assertDate(state.createdAt, 'createdAt');

    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition();
    this.assertTimestamp(at);

    if (this.requiresReference() && !referenceTransactionId?.trim()) {
      throw new InvalidWagerTransactionReferenceError(
        `${this.kind} must be processed with a resolved reference transaction id`,
      );
    }
    if (
      referenceTransactionId !== undefined &&
      !referenceTransactionId.trim()
    ) {
      throw new InvalidWagerTransactionReferenceError(
        'Reference transaction id must not be empty',
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = new Date(at.getTime());
  }

  markPendingReference(): void {
    this.assertCanTransition();
    if (
      this._status !== WagerTransactionStatus.Pending ||
      !this.referenceExternalTransactionId ||
      ![
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
      ].includes(this.kind)
    ) {
      throw new InvalidWagerTransactionTransitionError(
        this._status,
        WagerTransactionStatus.PendingReference,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._referenceTransactionId = undefined;
    this._processedAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._referenceTransactionId = undefined;
    this._processedAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Win:
        if (reference) {
          this.assertProcessedReference(reference, [WagerTransactionKind.Bet]);
        }
        return LedgerDirection.Credit;
      case WagerTransactionKind.Refund:
        this.assertProcessedReference(reference, [WagerTransactionKind.Bet]);
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          'LOSS does not produce a ledger entry',
        );
      case WagerTransactionKind.Rollback: {
        this.assertProcessedReference(reference, [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ]);
        const originalDirection =
          reference.kind === WagerTransactionKind.Bet
            ? LedgerDirection.Debit
            : LedgerDirection.Credit;
        return originalDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertProcessedReference(
    reference: WagerTransaction | undefined,
    allowedKinds: WagerTransactionKind[],
  ): asserts reference is WagerTransaction {
    if (!reference) {
      throw new InvalidWagerTransactionReferenceError(
        `${this.kind} requires a resolved reference transaction`,
      );
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidWagerTransactionReferenceError(
        'Reference transaction must be PROCESSED',
      );
    }
    if (!allowedKinds.includes(reference.kind)) {
      throw new InvalidWagerTransactionReferenceError(
        `${this.kind} cannot reference ${reference.kind}`,
      );
    }
  }

  private assertCanTransition(): void {
    if (this.isTerminal()) {
      throw new InvalidWagerTransactionStateError(this._status);
    }
  }

  private assertTimestamp(at: Date): void {
    WagerTransaction.assertDate(at, 'processedAt');
  }

  private static validateCommon(
    props:
      | CreateWagerTransactionProps
      | CreateOpeningWagerTransactionProps
      | WagerTransactionState,
  ): void {
    const fields = [
      ['id', props.id],
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['payloadHash', props.payloadHash],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
      ['roundId', props.roundId],
      ['gameId', props.gameId],
    ] as const;
    for (const [field, value] of fields) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidWagerTransactionError(`${field} must not be empty`);
      }
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError(
        'Transaction money cannot be negative',
      );
    }
  }

  private static validateReferenceRequirement(
    kind: WagerTransactionKind,
    referenceExternalTransactionId: string | undefined,
  ): void {
    const required =
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback;

    if (required && !referenceExternalTransactionId?.trim()) {
      throw new InvalidWagerTransactionReferenceError(
        `${kind} requires referenceExternalTransactionId`,
      );
    }

    if (
      referenceExternalTransactionId !== undefined &&
      !referenceExternalTransactionId.trim()
    ) {
      throw new InvalidWagerTransactionReferenceError(
        'referenceExternalTransactionId must not be empty',
      );
    }
    if (
      referenceExternalTransactionId !== undefined &&
      ![
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
      ].includes(kind)
    ) {
      throw new InvalidWagerTransactionReferenceError(
        `${kind} cannot contain referenceExternalTransactionId`,
      );
    }
  }

  private static assertDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidWagerTransactionError(`${field} must be a valid date`);
    }
  }
}
