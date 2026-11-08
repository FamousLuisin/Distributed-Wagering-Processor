import { EntitySchema } from '@mikro-orm/core';

export class InboxMessageEntity {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date;
}

export const InboxMessageEntitySchema = new EntitySchema<InboxMessageEntity>({
  class: InboxMessageEntity,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 128, fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', length: 128, fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'processed_at' },
  },
  indexes: [{ name: 'inbox_messages_received_idx', properties: ['receivedAt'] }],
});
