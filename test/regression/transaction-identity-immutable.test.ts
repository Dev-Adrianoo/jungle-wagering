import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { rejectionOf } from '../support/rejection';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

async function pendingReversal(): Promise<string> {
  const walletId = randomUUID();
  await db.query(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, 'BRL', '100.00', 1, now(), now())`,
    [walletId, randomUUID()],
  );
  const id = randomUUID();
  await db.query(
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        status, observed_balance, next_attempt_at, correlation_id, created_at, updated_at,
        observed_balance_currency)
     values (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'REFUND', '25.00', 'BRL',
        'ext-original', 'PENDING_REFERENCE', '100.00', now(), 'corr', now(), now(), 'BRL')`,
    [id, `ext-${id}`, `key-${id}`, 'a'.repeat(64), walletId, randomUUID()],
  );
  return id;
}

test.each([
  ['round_id', `'other'`],
  ['game_id', `'other'`],
  ['reference_external_transaction_id', `'other'`],
  ['correlation_id', `'other'`],
  ['created_at', `now() + interval '1 day'`],
])('a pending row cannot change %s', async (column, value) => {
  const id = await pendingReversal();

  const error = await rejectionOf(
    db.query(`update wager_transactions set ${column} = ${value} where id = ?`, [id]),
  );

  expect((error as Error).message).toMatch(/identity columns are immutable/);
});

test('retry bookkeeping stays updatable on a pending row', async () => {
  const id = await pendingReversal();

  await db.query(
    `update wager_transactions
       set reference_attempts = 1, next_attempt_at = now() + interval '1 minute', updated_at = now()
     where id = ?`,
    [id],
  );
});
