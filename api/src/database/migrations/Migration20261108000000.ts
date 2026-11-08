import { Migration } from '@mikro-orm/migrations';

export class Migration20261108000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" add column if not exists "resulting_balance" numeric(20, 2) null;',
    );
    this.addSql(`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conname = 'wager_transactions_resulting_balance_non_negative'
        ) then
          alter table "wager_transactions"
          add constraint "wager_transactions_resulting_balance_non_negative"
          check ("resulting_balance" is null or "resulting_balance" >= 0);
        end if;
      end
      $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'alter table "wager_transactions" drop constraint if exists "wager_transactions_resulting_balance_non_negative";',
    );
    this.addSql('alter table "wager_transactions" drop column if exists "resulting_balance";');
  }
}
