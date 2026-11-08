import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletLedgerEntryEntitySchema } from '../modules/ledger/infrastructure/wallet-ledger-entry.entity.js';
import { WagerTransactionEntitySchema } from '../modules/wagering/infrastructure/wager-transaction.entity.js';
import { WalletEntitySchema } from '../modules/wallets/infrastructure/wallet.entity.js';
import { InboxMessageEntitySchema } from '../modules/messaging/infrastructure/inbox-message.entity.js';
import { OutboxMessageEntitySchema } from '../modules/messaging/infrastructure/outbox-message.entity.js';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
  user: process.env.DB_USER ?? 'user',
  password: process.env.DB_PASSWORD ?? 'password',
  dbName: process.env.DB_NAME ?? 'wageringDatabase',
  entities: [
    WalletEntitySchema,
    WagerTransactionEntitySchema,
    WalletLedgerEntryEntitySchema,
    InboxMessageEntitySchema,
    OutboxMessageEntitySchema,
  ],
  extensions: [Migrator],
  migrations: {
    path: `${process.cwd()}/dist/database/migrations`,
    pathTs: `${process.cwd()}/src/database/migrations`,
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },
  allowGlobalContext: false,
  debug: process.env.NODE_ENV === 'development',
});
