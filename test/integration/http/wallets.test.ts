import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { call, startTestApp, type TestApp } from '../../support/http-app';
import { expectLedgerMatchesBalance } from '../../support/invariants';

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

const openBody = (overrides: Record<string, unknown> = {}) => ({
  playerId: randomUUID(),
  initialBalance: { amount: '1000.00', currency: 'BRL' },
  ...overrides,
});

const open = (overrides: Record<string, unknown> = {}) =>
  call(app, 'POST', '/wallets', { body: openBody(overrides) });

describe('POST /wallets', () => {
  test('creates a wallet', async () => {
    const body = openBody();

    const response = await call(app, 'POST', '/wallets', { body });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId: body.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    await expectLedgerMatchesBalance(db, response.body.id);
  });

  test('stores the caller correlation id on the opening transaction', async () => {
    const response = await call(app, 'POST', '/wallets', {
      body: openBody(),
      headers: { 'x-correlation-id': 'trace-open' },
    });

    const rows = await db.query<{ correlation_id: string }>(
      'select correlation_id from wager_transactions where wallet_id = ?',
      [response.body.id],
    );
    expect(rows.map((row) => row.correlation_id)).toEqual(['trace-open']);
    await expectLedgerMatchesBalance(db, response.body.id);
  });

  test('a second wallet for the same player and currency is 409', async () => {
    const body = openBody();
    await call(app, 'POST', '/wallets', { body });

    const response = await call(app, 'POST', '/wallets', { body });

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    ['a playerId that is not a UUID', { playerId: 'player-1' }, 'playerId'],
    ['a missing playerId', { playerId: undefined }, 'playerId'],
    ['a missing initial balance', { initialBalance: undefined }, 'initialBalance'],
    [
      'an amount sent as a JSON number',
      { initialBalance: { amount: 1000, currency: 'BRL' } },
      'initialBalance.amount',
    ],
    [
      'an amount with three decimals',
      { initialBalance: { amount: '10.001', currency: 'BRL' } },
      'initialBalance.amount',
    ],
    [
      'a negative amount',
      { initialBalance: { amount: '-1.00', currency: 'BRL' } },
      'initialBalance.amount',
    ],
    [
      'scientific notation',
      { initialBalance: { amount: '1e3', currency: 'BRL' } },
      'initialBalance.amount',
    ],
    [
      'a lowercase currency',
      { initialBalance: { amount: '1.00', currency: 'brl' } },
      'initialBalance.currency',
    ],
  ])('%s is 400 and names the field', async (_name, overrides, path) => {
    const response = await open(overrides);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.errors.map((issue: { path: string }) => issue.path)).toContain(path);
  });

  test('malformed JSON is 400 as problem+json with the correlation id', async () => {
    const response = await call(app, 'POST', '/wallets', {
      rawBody: '{"playerId": ',
      headers: { 'x-correlation-id': 'trace-bad-json' },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.correlationId).toBe('trace-bad-json');
  });

  test('a body that is not an object is 400', async () => {
    const response = await call(app, 'POST', '/wallets', { rawBody: '[]' });
    expect(response.status).toBe(400);
  });
});

describe('GET /wallets/:walletId', () => {
  test('returns the wallet', async () => {
    const created = await open();

    const response = await call(app, 'GET', `/wallets/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(created.body);
  });

  test('an unknown wallet is 404', async () => {
    const response = await call(app, 'GET', `/wallets/${randomUUID()}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('an id that is not a UUID is 400, not a database error', async () => {
    const response = await call(app, 'GET', '/wallets/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.errors[0].path).toBe('walletId');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('returns the opening entry with no next cursor', async () => {
    const created = await open();

    const response = await call(app, 'GET', `/wallets/${created.body.id}/ledger`);

    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  test.each([
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['limit=abc', 'limit'],
    ['limit=1.5', 'limit'],
    ['limit=-1', 'limit'],
  ])('%s is 400', async (query, path) => {
    const created = await open();

    const response = await call(app, 'GET', `/wallets/${created.body.id}/ledger?${query}`);

    expect(response.status).toBe(400);
    expect(response.body.errors[0].path).toBe(path);
  });

  test('a cursor that was not issued by the API is 400', async () => {
    const created = await open();

    const response = await call(app, 'GET', `/wallets/${created.body.id}/ledger?cursor=@@@`);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  test('an unknown wallet is 404', async () => {
    const response = await call(app, 'GET', `/wallets/${randomUUID()}/ledger`);
    expect(response.status).toBe(404);
  });

  test('a wallet id that is not a UUID is 400', async () => {
    const response = await call(app, 'GET', '/wallets/not-a-uuid/ledger');
    expect(response.status).toBe(400);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('reports a consistent wallet', async () => {
    const created = await open();

    const response = await call(app, 'POST', `/wallets/${created.body.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: created.body.id,
      storedBalance: { amount: '1000.00', currency: 'BRL' },
      calculatedBalance: { amount: '1000.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  test('flags a divergence and does not fix it', async () => {
    const created = await open();
    await db.query('update wallets set balance = balance - 0.01 where id = ?', [created.body.id]);

    const first = await call(app, 'POST', `/wallets/${created.body.id}/reconciliation`);
    const second = await call(app, 'POST', `/wallets/${created.body.id}/reconciliation`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      storedBalance: { amount: '999.99', currency: 'BRL' },
      calculatedBalance: { amount: '1000.00', currency: 'BRL' },
      difference: { amount: '-0.01', currency: 'BRL' },
      consistent: false,
    });
    expect(second.body).toEqual(first.body);
  });

  test('an unknown wallet is 404 and a malformed id is 400', async () => {
    expect((await call(app, 'POST', `/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
    expect((await call(app, 'POST', '/wallets/not-a-uuid/reconciliation')).status).toBe(400);
  });
});
