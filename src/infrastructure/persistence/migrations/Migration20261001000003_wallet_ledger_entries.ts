import { Migration } from '@mikro-orm/migrations';

export class Migration20261001000003_wallet_ledger_entries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        seq bigint GENERATED ALWAYS AS IDENTITY,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        wallet_version integer NOT NULL,
        direction text NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL,
        balance_after numeric(20,2) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_seq_unique UNIQUE (seq),
        CONSTRAINT ledger_wallet_transaction_unique UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_wallet_version_unique UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
          OR direction NOT IN ('DEBIT', 'CREDIT')
        )
      )
    `);
    this.addSql('CREATE INDEX ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)');
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_append_only()
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only()
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE wallet_ledger_entries');
    this.addSql('DROP FUNCTION ledger_append_only()');
  }
}
