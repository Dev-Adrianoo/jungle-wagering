import { Migration } from '@mikro-orm/migrations';

export class Migration20261001000002_wager_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        player_id uuid NOT NULL,
        round_id text,
        game_id text,
        kind text NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions (id),
        status text NOT NULL,
        failure_code text,
        observed_balance numeric(20,2) NOT NULL,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        correlation_id text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        processed_at timestamptz,
        CONSTRAINT wager_tx_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_idempotency_key_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_amount_positive_unless_loss CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT wager_tx_observed_balance_non_negative CHECK (observed_balance >= 0),
        CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_round_game_required
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT wager_tx_reference_required
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_required
          CHECK (status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_processed_at_required
          CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
        CONSTRAINT wager_tx_next_attempt_required
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);
    this.addSql(
      'CREATE INDEX wager_tx_wallet_created ON wager_transactions (wallet_id, created_at)',
    );
    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted'
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal and cannot change', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.kind, NEW.amount, NEW.currency)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.kind, OLD.amount, OLD.currency)
        THEN
          RAISE EXCEPTION 'wager transaction % identity columns are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard
        BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP FUNCTION wager_tx_guard()');
  }
}
