import { EntitySchema } from '@mikro-orm/core';

export class OutboxMessageEntity {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  createdAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  leaseToken!: string | null;
  leaseUntil!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageEntitySchema = new EntitySchema<OutboxMessageEntity>({
  class: OutboxMessageEntity,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', length: 128, fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'occurred_at' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'next_attempt_at' },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'published_at' },
    leaseToken: { type: 'uuid', nullable: true, fieldName: 'lease_token' },
    leaseUntil: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'lease_until' },
    lastError: { type: 'string', columnType: 'text', nullable: true, fieldName: 'last_error' },
  },
  indexes: [
    {
      name: 'outbox_messages_pending_idx',
      properties: ['nextAttemptAt', 'createdAt'],
      where: '"published_at" is null',
    },
    {
      name: 'outbox_messages_expired_lease_idx',
      properties: ['leaseUntil'],
      where: '"published_at" is null and "lease_until" is not null',
    },
  ],
});
