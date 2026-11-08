import { Migration } from '@mikro-orm/migrations';

export class Migration20261110000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "pending_reference_attempts" integer not null default 0,
        add column "pending_reference_next_attempt_at" timestamptz null,
        add column "pending_reference_expires_at" timestamptz null,
        add column "pending_reference_lease_token" uuid null,
        add column "pending_reference_lease_until" timestamptz null;
    `);

    this.addSql(`
      update "wager_transactions"
      set "pending_reference_next_attempt_at" = now() + interval '1 second',
          "pending_reference_expires_at" = now() + interval '15 minutes'
      where "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_pending_reference_attempts_non_negative"
          check ("pending_reference_attempts" >= 0),
        add constraint "wager_transactions_pending_reference_schedule_check"
          check (
            ("status" = 'PENDING_REFERENCE'
              and "pending_reference_next_attempt_at" is not null
              and "pending_reference_expires_at" is not null
              and "pending_reference_next_attempt_at" <= "pending_reference_expires_at")
            or
            ("status" <> 'PENDING_REFERENCE'
              and "pending_reference_next_attempt_at" is null
              and "pending_reference_expires_at" is null)
          ),
        add constraint "wager_transactions_pending_reference_lease_pair"
          check (("pending_reference_lease_token" is null) = ("pending_reference_lease_until" is null)),
        add constraint "wager_transactions_pending_reference_lease_status"
          check ("pending_reference_lease_token" is null or "status" = 'PENDING_REFERENCE');
    `);

    this.addSql(`
      create index "wager_transactions_pending_reference_due_idx"
      on "wager_transactions" ("pending_reference_next_attempt_at", "pending_reference_expires_at")
      where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_pending_reference_due_idx";');
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_pending_reference_lease_status",
        drop constraint if exists "wager_transactions_pending_reference_lease_pair",
        drop constraint if exists "wager_transactions_pending_reference_schedule_check",
        drop constraint if exists "wager_transactions_pending_reference_attempts_non_negative",
        drop column if exists "pending_reference_lease_until",
        drop column if exists "pending_reference_lease_token",
        drop column if exists "pending_reference_expires_at",
        drop column if exists "pending_reference_next_attempt_at",
        drop column if exists "pending_reference_attempts";
    `);
  }
}
