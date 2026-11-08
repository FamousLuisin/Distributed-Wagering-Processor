import { EntitySchema } from '@mikro-orm/core';

export class WalletLedgerEntryEntity {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntryEntitySchema = new EntitySchema<WalletLedgerEntryEntity>({
  class: WalletLedgerEntryEntity,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', length: 8 },
    amount: { type: 'numeric', columnType: 'numeric(20,2)' },
    currency: { type: 'string', length: 3 },
    balanceBefore: { type: 'numeric', columnType: 'numeric(20,2)', fieldName: 'balance_before' },
    balanceAfter: { type: 'numeric', columnType: 'numeric(20,2)', fieldName: 'balance_after' },
    createdAt: { type: 'datetime', columnType: 'timestamptz', fieldName: 'created_at' },
  },
  uniques: [{ name: 'wallet_ledger_wallet_transaction_unique', properties: ['walletId', 'transactionId'] }],
  indexes: [{ name: 'wallet_ledger_wallet_created_idx', properties: ['walletId', 'createdAt', 'id'] }],
});
