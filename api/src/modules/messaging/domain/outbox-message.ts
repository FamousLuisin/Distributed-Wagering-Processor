import type { IntegrationEvent } from './integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  createdAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  leaseToken?: string;
  leaseUntil?: Date;
  lastError?: string;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private readonly _createdAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
    private _leaseToken?: string,
    private _leaseUntil?: Date,
    private _lastError?: string,
  ) {}

  static enqueue<T>(event: IntegrationEvent<T>, createdAt = new Date()): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON() as unknown as Record<string, unknown>,
      occurredAt: event.occurredAt,
      createdAt,
      attempts: 0,
      nextAttemptAt: createdAt,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    for (const [field, value] of [
      ['id', state.id],
      ['aggregateId', state.aggregateId],
      ['eventType', state.eventType],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${field} must not be empty`);
      }
    }
    for (const field of ['occurredAt', 'createdAt', 'nextAttemptAt'] as const) {
      OutboxMessage.assertDate(state[field], field);
    }
    if (state.publishedAt) OutboxMessage.assertDate(state.publishedAt, 'publishedAt');
    if (state.leaseUntil) OutboxMessage.assertDate(state.leaseUntil, 'leaseUntil');
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new Error('attempts must be a non-negative integer');
    }
    if (Boolean(state.leaseToken) !== Boolean(state.leaseUntil)) {
      throw new Error('leaseToken and leaseUntil must be set together');
    }

    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      new Date(state.occurredAt.getTime()),
      new Date(state.createdAt.getTime()),
      state.attempts,
      new Date(state.nextAttemptAt.getTime()),
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
      state.leaseToken,
      state.leaseUntil ? new Date(state.leaseUntil.getTime()) : undefined,
      state.lastError,
    );
  }

  get occurredAt(): Date { return new Date(this._occurredAt.getTime()); }
  get createdAt(): Date { return new Date(this._createdAt.getTime()); }
  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date { return new Date(this._nextAttemptAt.getTime()); }
  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }
  get leaseToken(): string | undefined { return this._leaseToken; }
  get leaseUntil(): Date | undefined {
    return this._leaseUntil ? new Date(this._leaseUntil.getTime()) : undefined;
  }
  get lastError(): string | undefined { return this._lastError; }

  isPending(): boolean { return this._publishedAt === undefined; }

  isDue(now: Date): boolean {
    OutboxMessage.assertDate(now, 'now');
    return this.isPending() && this._nextAttemptAt <= now &&
      (!this._leaseUntil || this._leaseUntil <= now);
  }

  markPublished(at: Date): void {
    OutboxMessage.assertDate(at, 'publishedAt');
    if (!this.isPending()) throw new Error('Outbox message is already published');
    this._publishedAt = new Date(at.getTime());
    this._leaseToken = undefined;
    this._leaseUntil = undefined;
    this._lastError = undefined;
  }

  scheduleRetry(now: Date, error: string, maxDelayMs = 300_000): void {
    OutboxMessage.assertDate(now, 'now');
    if (!this.isPending()) throw new Error('Published outbox message cannot retry');
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 1) {
      throw new Error('maxDelayMs must be positive');
    }
    this._attempts += 1;
    const delayMs = Math.min(1_000 * 2 ** Math.min(this._attempts - 1, 30), maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
    this._lastError = error;
    this._leaseToken = undefined;
    this._leaseUntil = undefined;
  }

  claim(leaseToken: string, leaseUntil: Date, now: Date): void {
    OutboxMessage.assertDate(leaseUntil, 'leaseUntil');
    if (!leaseToken.trim()) throw new Error('leaseToken must not be empty');
    if (!this.isDue(now)) throw new Error('Outbox message is not due');
    if (leaseUntil <= now) throw new Error('leaseUntil must be in the future');
    this._leaseToken = leaseToken;
    this._leaseUntil = new Date(leaseUntil.getTime());
  }

  private static assertDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error(`${field} must be a valid date`);
    }
  }
}
