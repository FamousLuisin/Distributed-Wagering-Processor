import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20, 2) not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency")
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(128) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255) not null,
        "payload_hash" varchar(128) not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255) not null,
        "game_id" varchar(255) not null,
        "kind" varchar(16) not null,
        "amount" numeric(20, 2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" varchar(255) null,
        "reference_transaction_id" uuid null,
        "status" varchar(24) not null,
        "failure_code" varchar(64) null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_reference_fk" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_non_negative" check ("amount" >= 0),
        constraint "wager_transactions_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_reference_required" check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_reference_not_self" check ("reference_transaction_id" is null or "reference_transaction_id" <> "id"),
        constraint "wager_transactions_processed_at_check" check (("status" = 'PROCESSED' and "processed_at" is not null) or ("status" <> 'PROCESSED' and "processed_at" is null)),
        constraint "wager_transactions_id_wallet_unique" unique ("id", "wallet_id"),
        constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key"),
        constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id")
      );
    `);
    this.addSql(`create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id", "created_at");`);
    this.addSql(`create index "wager_transactions_pending_reference_idx" on "wager_transactions" ("created_at") where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`create unique index "wager_transactions_reference_reversal_unique" on "wager_transactions" ("reference_transaction_id", "kind") where "kind" in ('REFUND', 'ROLLBACK') and "reference_transaction_id" is not null;`);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(8) not null,
        "amount" numeric(20, 2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20, 2) not null,
        "balance_after" numeric(20, 2) not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "wallet_ledger_transaction_wallet_fk" foreign key ("transaction_id", "wallet_id") references "wager_transactions" ("id", "wallet_id") on update cascade on delete restrict,
        constraint "wallet_ledger_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_balances_non_negative" check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_currency_format" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_balanced" check (("direction" = 'DEBIT' and "balance_before" - "amount" = "balance_after") or ("direction" = 'CREDIT' and "balance_before" + "amount" = "balance_after")),
        constraint "wallet_ledger_wallet_transaction_unique" unique ("wallet_id", "transaction_id")
      );
    `);
    this.addSql(`create index "wallet_ledger_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);

    this.addSql(`
      create function prevent_wallet_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger "wallet_ledger_entries_append_only"
      before update or delete on "wallet_ledger_entries"
      for each row execute function prevent_wallet_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists "wallet_ledger_entries_append_only" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists prevent_wallet_ledger_mutation();`);
    this.addSql(`drop table if exists "wallet_ledger_entries";`);
    this.addSql(`drop table if exists "wager_transactions";`);
    this.addSql(`drop table if exists "wallets";`);
  }
}
