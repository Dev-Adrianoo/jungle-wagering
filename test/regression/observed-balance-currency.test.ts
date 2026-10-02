import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { call, startTestApp, type TestApp } from '../support/http-app';
import { expectLedgerMatchesBalance } from '../support/invariants';

let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

test('after a currency mismatch the replay and lookups keep the wallet currency', async () => {
  const opened = await call(app, 'POST', '/wallets', {
    body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
  });
  const wallet = opened.body;
  const body = {
    providerId: 'provider-a',
    externalTransactionId: 'ext-currency-1',
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'USD' },
  };
  const headers = { 'idempotency-key': 'provider-a:ext-currency-1' };

  const first = await call(app, 'POST', '/wagering/transactions', { body, headers });
  expect(first.status).toBe(422);
  expect(first.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });

  const replay = await call(app, 'POST', '/wagering/transactions', { body, headers });
  expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

  const byId = await call(app, 'GET', `/wagering/transactions/${first.body.transactionId}`);
  expect(byId.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  const byProvider = await call(
    app,
    'GET',
    `/providers/provider-a/wagering/transactions/ext-currency-1`,
  );
  expect(byProvider.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  await expectLedgerMatchesBalance(db, wallet.id);
});
