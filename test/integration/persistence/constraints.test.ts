import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../../support/database';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function settle(statement: Promise<unknown>): Promise<{ error?: unknown }> {
  return statement.then(
    () => ({}),
    (error: unknown) => ({ error }),
  );
}

// Bun hangs when `expect(promise).rejects` is handed a driver query that is still pending, so
// the statement is awaited first and the assertion runs on the settled outcome.
async function expectRejection(statement: Promise<unknown>, constraint: RegExp): Promise<void> {
  const { error } = await settle(statement);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(constraint);
}

async function expectAccepted(statement: Promise<unknown>): Promise<void> {
  const { error } = await settle(statement);
  expect(error).toBeUndefined();
}

async function insertWallet(overrides: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    ...overrides,
  };
  await db.query(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [row.id, row.player_id, row.currency, row.balance, row.version],
  );
  return row;
}

async function insertTransaction(walletId: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const row = {
    id,
    provider_id: 'provider-a',
    external_transaction_id: `ext-${id}`,
    idempotency_key: `key-${id}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: randomUUID(),
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    observed_balance: '75.00',
    observed_balance_currency: 'BRL',
    next_attempt_at: null,
    processed_at: new Date(),
    ...overrides,
  };
  await db.query(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, observed_balance, observed_balance_currency,
        next_attempt_at, correlation_id, created_at, updated_at, processed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'corr', now(), now(), ?)`,
    [
      row.id,
      row.provider_id,
      row.external_transaction_id,
      row.idempotency_key,
      row.payload_hash,
      row.wallet_id,
      row.player_id,
      row.round_id,
      row.game_id,
      row.kind,
      row.amount,
      row.currency,
      row.reference_external_transaction_id,
      row.reference_transaction_id,
      row.status,
      row.failure_code,
      row.observed_balance,
      row.observed_balance_currency,
      row.next_attempt_at,
      row.processed_at,
    ],
  );
  return row;
}

async function insertLedgerEntry(
  walletId: string,
  transactionId: string,
  overrides: Record<string, unknown> = {},
) {
  const row = {
    id: randomUUID(),
    wallet_version: 2,
    direction: 'DEBIT',
    amount: '25.00',
    balance_before: '100.00',
    balance_after: '75.00',
    ...overrides,
  };
  await db.query(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
        balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
    [
      row.id,
      walletId,
      transactionId,
      row.wallet_version,
      row.direction,
      row.amount,
      row.balance_before,
      row.balance_after,
    ],
  );
  return row;
}

describe('wallets', () => {
  test('refuses a negative balance on insert', async () => {
    await expectRejection(insertWallet({ balance: '-0.01' }), /wallets_balance_non_negative/);
  });

  test('refuses an update that would make the balance negative', async () => {
    const wallet = await insertWallet();
    await expectRejection(
      db.query('update wallets set balance = balance - 100.01 where id = ?', [wallet.id]),
      /wallets_balance_non_negative/,
    );
  });

  test('allows one wallet per player and currency', async () => {
    const wallet = await insertWallet();

    await expectRejection(
      insertWallet({ player_id: wallet.player_id }),
      /wallets_player_currency_unique/,
    );
    await expectAccepted(insertWallet({ player_id: wallet.player_id, currency: 'USD' }));
  });

  test('refuses a NaN balance', async () => {
    await expectRejection(insertWallet({ balance: 'NaN' }), /wallets_balance_is_a_number/);
  });

  test('refuses a version below 1', async () => {
    await expectRejection(insertWallet({ version: 0 }), /wallets_version_positive/);
  });

  test('refuses a malformed currency', async () => {
    await expectRejection(insertWallet({ currency: 'brl' }), /wallets_currency_format/);
  });
});

describe('wager_transactions', () => {
  test('refuses a duplicate (provider, external id)', async () => {
    const wallet = await insertWallet();
    const first = await insertTransaction(wallet.id);

    await expectRejection(
      insertTransaction(wallet.id, { external_transaction_id: first.external_transaction_id }),
      /wager_tx_provider_external_unique/,
    );
  });

  test('refuses a duplicate idempotency key', async () => {
    const wallet = await insertWallet();
    const first = await insertTransaction(wallet.id);

    await expectRejection(
      insertTransaction(wallet.id, { idempotency_key: first.idempotency_key }),
      /wager_tx_idempotency_key_unique/,
    );
  });

  test.each([
    ['an unknown kind', { kind: 'DEPOSIT' }, /wager_tx_kind_valid/],
    ['an unknown status', { status: 'DONE' }, /wager_tx_status_valid/],
    ['a zero BET', { amount: '0.00' }, /wager_tx_amount_positive_unless_loss/],
    ['a negative amount', { kind: 'LOSS', amount: '-1.00' }, /wager_tx_amount_non_negative/],
    ['a BET without round', { round_id: null }, /wager_tx_round_game_required/],
    [
      'a REFUND without reference',
      { kind: 'REFUND', status: 'REJECTED', failure_code: 'X', processed_at: null },
      /wager_tx_reference_required/,
    ],
    [
      'a PROCESSED REFUND without a resolved reference',
      { kind: 'REFUND', reference_external_transaction_id: 'ext-x' },
      /wager_tx_processed_reversal_resolved/,
    ],
    ['a NaN amount', { amount: 'NaN' }, /wager_tx_amounts_are_numbers/],
    ['a NaN observed balance', { observed_balance: 'NaN' }, /wager_tx_amounts_are_numbers/],
    [
      'a REJECTED row without failure code',
      { status: 'REJECTED', processed_at: null },
      /wager_tx_failure_code_required/,
    ],
    [
      'a PROCESSED row without processed_at',
      { processed_at: null },
      /wager_tx_processed_at_required/,
    ],
    [
      'a PENDING_REFERENCE row without next attempt',
      { status: 'PENDING_REFERENCE', processed_at: null },
      /wager_tx_next_attempt_required/,
    ],
  ])('refuses %s', async (_name, overrides, constraint) => {
    const wallet = await insertWallet();
    await expectRejection(insertTransaction(wallet.id, overrides), constraint);
  });

  test('accepts a zero LOSS', async () => {
    const wallet = await insertWallet();
    await expectAccepted(insertTransaction(wallet.id, { kind: 'LOSS', amount: '0.00' }));
  });

  test('allows only one PROCESSED reversal per reference', async () => {
    const wallet = await insertWallet();
    const bet = await insertTransaction(wallet.id);
    const reversal = {
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
    };

    await insertTransaction(wallet.id, { kind: 'REFUND', ...reversal });

    await expectRejection(
      insertTransaction(wallet.id, { kind: 'ROLLBACK', ...reversal }),
      /wager_tx_single_reversal/,
    );
    await expectAccepted(
      insertTransaction(wallet.id, {
        kind: 'REFUND',
        ...reversal,
        status: 'REJECTED',
        failure_code: 'REFERENCE_ALREADY_REVERSED',
        processed_at: null,
      }),
    );
  });

  test('a terminal row cannot be updated', async () => {
    const wallet = await insertWallet();
    const tx = await insertTransaction(wallet.id);

    await expectRejection(
      db.query(
        `update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?`,
        [tx.id],
      ),
      /terminal and cannot change/,
    );
  });

  test('identity columns cannot change while the row is still pending', async () => {
    const wallet = await insertWallet();
    const bet = await insertTransaction(wallet.id);
    const pending = await insertTransaction(wallet.id, {
      kind: 'REFUND',
      reference_external_transaction_id: bet.external_transaction_id,
      status: 'PENDING_REFERENCE',
      next_attempt_at: new Date(),
      processed_at: null,
    });

    await expectRejection(
      db.query('update wager_transactions set amount = 1.00 where id = ?', [pending.id]),
      /identity columns are immutable/,
    );
    await expectAccepted(
      db.query('update wager_transactions set reference_attempts = 1 where id = ?', [pending.id]),
    );
  });

  test('rows cannot be deleted', async () => {
    const wallet = await insertWallet();
    const tx = await insertTransaction(wallet.id);

    await expectRejection(
      db.query('delete from wager_transactions where id = ?', [tx.id]),
      /cannot be deleted/,
    );
  });
});

describe('wallet_ledger_entries', () => {
  async function walletWithBet() {
    const wallet = await insertWallet();
    const tx = await insertTransaction(wallet.id);
    return { wallet, tx };
  }

  test.each([
    ['arithmetic that does not close', { balance_after: '80.00' }, /ledger_arithmetic/],
    [
      'a debit recorded as a credit',
      { direction: 'CREDIT', balance_after: '75.00' },
      /ledger_arithmetic/,
    ],
    ['a zero amount', { amount: '0.00', balance_after: '100.00' }, /ledger_amount_positive/],
    ['a NaN amount', { amount: 'NaN', balance_after: 'NaN' }, /ledger_amounts_are_numbers/],
    ['a NaN balance before', { balance_before: 'NaN' }, /ledger_amounts_are_numbers/],
    ['a NaN balance after', { balance_after: 'NaN' }, /ledger_amounts_are_numbers/],
    ['an unknown direction', { direction: 'TRANSFER' }, /ledger_direction_valid/],
    [
      'a negative balance after',
      { amount: '150.00', balance_after: '-50.00' },
      /ledger_balance_after_non_negative/,
    ],
  ])('refuses %s', async (_name, overrides, constraint) => {
    const { wallet, tx } = await walletWithBet();
    await expectRejection(insertLedgerEntry(wallet.id, tx.id, overrides), constraint);
  });

  test('allows one entry per transaction in a wallet', async () => {
    const { wallet, tx } = await walletWithBet();
    await insertLedgerEntry(wallet.id, tx.id);

    await expectRejection(
      insertLedgerEntry(wallet.id, tx.id, { wallet_version: 3 }),
      /ledger_wallet_transaction_unique/,
    );
  });

  test('allows one entry per wallet version', async () => {
    const { wallet, tx } = await walletWithBet();
    const other = await insertTransaction(wallet.id);
    await insertLedgerEntry(wallet.id, tx.id);

    await expectRejection(insertLedgerEntry(wallet.id, other.id), /ledger_wallet_version_unique/);
  });

  test('entries cannot be updated, deleted or truncated', async () => {
    const { wallet, tx } = await walletWithBet();
    const entry = await insertLedgerEntry(wallet.id, tx.id);

    await expectRejection(
      db.query('update wallet_ledger_entries set amount = 1.00 where id = ?', [entry.id]),
      /append-only/,
    );
    await expectRejection(
      db.query('delete from wallet_ledger_entries where id = ?', [entry.id]),
      /append-only/,
    );
    await expectRejection(db.query('truncate wallet_ledger_entries'), /append-only/);
  });
});

describe('inbox_messages', () => {
  test('refuses the same message twice for the same consumer', async () => {
    const insert = (consumer: string) =>
      db.query(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
         values (?, 'msg-1', ?, now())`,
        [consumer, 'a'.repeat(64)],
      );

    await insert('consumer-a');

    await expectRejection(insert('consumer-a'), /inbox_messages_pk/);
    await expectAccepted(insert('consumer-b'));
  });
});

describe('outbox_messages', () => {
  test('a pending message must have a next attempt', async () => {
    await expectRejection(
      db.query(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         values (?, ?, 'X', '{}', now())`,
        [randomUUID(), randomUUID()],
      ),
      /outbox_pending_has_next_attempt/,
    );
  });
});
