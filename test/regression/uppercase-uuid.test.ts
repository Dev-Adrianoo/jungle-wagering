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

test('upper-case uuids are normalised: bet processed, retry replays, lookup works', async () => {
  const opened = await call(app, 'POST', '/wallets', {
    body: {
      playerId: randomUUID().toUpperCase(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    },
  });
  expect(opened.status).toBe(201);
  const wallet = opened.body;

  const bet = (casing: (value: string) => string) => ({
    providerId: 'provider-a',
    externalTransactionId: 'ext-upper-1',
    playerId: casing(wallet.playerId),
    walletId: casing(wallet.id),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  });
  const headers = { 'idempotency-key': 'provider-a:ext-upper-1' };

  const first = await call(app, 'POST', '/wagering/transactions', {
    body: bet((value) => value.toUpperCase()),
    headers,
  });
  expect(first.status).toBe(201);
  expect(first.body.status).toBe('PROCESSED');

  const retry = await call(app, 'POST', '/wagering/transactions', {
    body: bet((value) => value.toLowerCase()),
    headers,
  });
  expect(retry.status).toBe(200);
  expect(retry.body.idempotentReplay).toBe(true);

  const lookup = await call(app, 'GET', `/wallets/${wallet.id.toUpperCase()}`);
  expect(lookup.status).toBe(200);
  expect(lookup.body.balance.amount).toBe('75.00');
  await expectLedgerMatchesBalance(db, wallet.id);
});
