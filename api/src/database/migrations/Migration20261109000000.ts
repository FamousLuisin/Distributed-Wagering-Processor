import { Migration } from '@mikro-orm/migrations';

export class Migration20261109000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "message_id" varchar(128) not null,
        "consumer_name" varchar(128) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id"),
        constraint "inbox_messages_payload_hash_format" check ("payload_hash" ~ '^[a-f0-9]{64}$'),
        constraint "inbox_messages_processed_after_received" check ("processed_at" is null or "processed_at" >= "received_at")
      );
    `);
    this.addSql(`create index "inbox_messages_received_idx" on "inbox_messages" ("received_at");`);

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(128) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "created_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null,
        "published_at" timestamptz null,
        "lease_token" uuid null,
        "lease_until" timestamptz null,
        "last_error" text null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_event_type_non_empty" check (length(trim("event_type")) > 0),
        constraint "outbox_messages_payload_object" check (jsonb_typeof("payload") = 'object'),
        constraint "outbox_messages_attempts_non_negative" check ("attempts" >= 0),
        constraint "outbox_messages_lease_pair" check (("lease_token" is null) = ("lease_until" is null)),
        constraint "outbox_messages_published_unleased" check ("published_at" is null or ("lease_token" is null and "lease_until" is null))
      );
    `);
    this.addSql(`create index "outbox_messages_pending_idx" on "outbox_messages" ("next_attempt_at", "created_at") where "published_at" is null;`);
    this.addSql(`create index "outbox_messages_expired_lease_idx" on "outbox_messages" ("lease_until") where "published_at" is null and "lease_until" is not null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "outbox_messages";');
    this.addSql('drop table if exists "inbox_messages";');
  }
}
