import { Migration } from '@mikro-orm/migrations';

export class Migration20261001000004_inbox_outbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      )
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT outbox_pending_has_next_attempt
          CHECK (published_at IS NOT NULL OR next_attempt_at IS NOT NULL)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE outbox_messages');
    this.addSql('DROP TABLE inbox_messages');
  }
}
