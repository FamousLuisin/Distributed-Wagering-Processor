import { EntitySchema } from '@mikro-orm/core';

export class WagerTransactionEntity {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  resultingBalance?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status!: string;
  failureCode?: string;
  createdAt!: Date;
  processedAt?: Date;
  pendingReferenceAttempts!: number;
  pendingReferenceNextAttemptAt!: Date | null;
  pendingReferenceExpiresAt!: Date | null;
  pendingReferenceLeaseToken!: string | null;
  pendingReferenceLeaseUntil!: Date | null;
}

export const WagerTransactionEntitySchema = new EntitySchema<WagerTransactionEntity>({
  class: WagerTransactionEntity,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 128, fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', length: 128, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string', length: 16 },
    amount: { type: 'numeric', columnType: 'numeric(20,2)' },
    currency: { type: 'string', length: 3 },
    resultingBalance: { type: 'numeric', columnType: 'numeric(20,2)', nullable: true, fieldName: 'resulting_balance' },
    referenceExternalTransactionId: { type: 'string', nullable: true, fieldName: 'reference_external_transaction_id' },
    referenceTransactionId: { type: 'uuid', nullable: true, fieldName: 'reference_transaction_id' },
    status: { type: 'string', length: 24 },
    failureCode: { type: 'string', length: 64, nullable: true, fieldName: 'failure_code' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'processed_at' },
    pendingReferenceAttempts: { type: 'integer', default: 0, fieldName: 'pending_reference_attempts' },
    pendingReferenceNextAttemptAt: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'pending_reference_next_attempt_at' },
    pendingReferenceExpiresAt: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'pending_reference_expires_at' },
    pendingReferenceLeaseToken: { type: 'uuid', nullable: true, fieldName: 'pending_reference_lease_token' },
    pendingReferenceLeaseUntil: { type: 'datetime', columnType: 'timestamptz', nullable: true, fieldName: 'pending_reference_lease_until' },
  },
  uniques: [
    { name: 'wager_transactions_idempotency_key_unique', properties: ['idempotencyKey'] },
    { name: 'wager_transactions_provider_external_unique', properties: ['providerId', 'externalTransactionId'] },
    { name: 'wager_transactions_id_wallet_unique', properties: ['id', 'walletId'] },
    {
      name: 'wager_transactions_reference_reversal_unique',
      properties: ['referenceTransactionId', 'kind'],
      where: '"kind" in (\'REFUND\', \'ROLLBACK\') and "reference_transaction_id" is not null',
    },
  ],
  indexes: [
    { name: 'wager_transactions_wallet_created_idx', properties: ['walletId', 'createdAt'] },
    { name: 'wager_transactions_pending_reference_idx', properties: ['createdAt'], where: '"status" = \'PENDING_REFERENCE\'' },
    { name: 'wager_transactions_pending_reference_due_idx', properties: ['pendingReferenceNextAttemptAt', 'pendingReferenceExpiresAt'], where: '"status" = \'PENDING_REFERENCE\'' },
  ],
});
