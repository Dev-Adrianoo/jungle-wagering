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

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(amount: string): Promise<Wallet> {
  const response = await call(app, 'POST', '/wallets', {
    body: { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } },
  });
  return response.body;
}

function payload(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function send(body: ReturnType<typeof payload>, key?: string) {
  return call(app, 'POST', '/wagering/transactions', {
    body,
    headers: { 'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}` },
  });
}

const balanceOf = async (walletId: string) =>
  (await call(app, 'GET', `/wallets/${walletId}`)).body.balance.amount;

describe('POST /wagering/transactions', () => {
  test('a new BET is 201 with the documented body', async () => {
    const wallet = await openWallet('1000.00');

    const response = await send(payload(wallet));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: response.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(response.body.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('an identical retry is 200 with idempotentReplay true and the same body', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);
    const original = await send(body);

    const replay = await send(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(await balanceOf(wallet.id)).toBe('975.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a business rejection is 422 with the failure code, also on replay', async () => {
    const wallet = await openWallet('20.00');
    const body = payload(wallet, { money: { amount: '80.00', currency: 'BRL' } });

    const original = await send(body);
    const replay = await send(body);

    expect(original.status).toBe(422);
    expect(original.body).toEqual({
      transactionId: original.body.transactionId,
      status: 'REJECTED',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a reversal that arrives before its reference is 202', async () => {
    const wallet = await openWallet('100.00');

    const response = await send(
      payload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet-here' }),
    );

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('the same key with another payload is 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);
    await send(body);

    const response = await send({ ...body, money: { amount: '26.00', currency: 'BRL' } });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await balanceOf(wallet.id)).toBe('975.00');
  });

  test('the same provider transaction under another key is 409', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);
    await send(body);

    const response = await send(body, `other-${randomUUID()}`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('DUPLICATE_EXTERNAL_TRANSACTION');
  });

  test('an unknown wallet is 404', async () => {
    const response = await send(payload({ id: randomUUID(), playerId: randomUUID() }));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('a missing Idempotency-Key is 400 IDEMPOTENCY_KEY_MISSING', async () => {
    const wallet = await openWallet('100.00');

    const response = await call(app, 'POST', '/wagering/transactions', { body: payload(wallet) });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('a blank Idempotency-Key is 400', async () => {
    const wallet = await openWallet('100.00');
    const response = await send(payload(wallet), '   ');
    expect(response.status).toBe(400);
  });

  test.each([
    ['a wallet id that is not a UUID', { walletId: 'wallet-1' }, 'walletId'],
    ['a player id that is not a UUID', { playerId: 'player-1' }, 'playerId'],
    ['an amount sent as a number', { money: { amount: 25, currency: 'BRL' } }, 'money.amount'],
    ['three decimals', { money: { amount: '25.001', currency: 'BRL' } }, 'money.amount'],
    ['a negative amount', { money: { amount: '-25.00', currency: 'BRL' } }, 'money.amount'],
    ['a zero BET', { money: { amount: '0.00', currency: 'BRL' } }, 'money.amount'],
    ['kind OPENING', { kind: 'OPENING' }, 'kind'],
    ['the reserved provider id', { providerId: 'internal' }, 'providerId'],
    ['a REFUND without reference', { kind: 'REFUND' }, 'referenceExternalTransactionId'],
  ])('%s is 400, names the field and moves nothing', async (_name, overrides, path) => {
    const wallet = await openWallet('100.00');
    const body = payload(wallet, overrides);

    const response = await call(app, 'POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': `key-${randomUUID()}` },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.errors.map((issue: { path: string }) => issue.path)).toContain(path);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('the validation response does not echo the submitted amount', async () => {
    const wallet = await openWallet('100.00');

    const response = await call(app, 'POST', '/wagering/transactions', {
      body: payload(wallet, { money: { amount: '31337.123', currency: 'BRL' } }),
      headers: { 'idempotency-key': `key-${randomUUID()}` },
    });

    expect(JSON.stringify(response.body)).not.toContain('31337');
  });

  test('stores the caller correlation id on the transaction', async () => {
    const wallet = await openWallet('100.00');
    const body = payload(wallet);

    const response = await call(app, 'POST', '/wagering/transactions', {
      body,
      headers: {
        'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
        'x-correlation-id': 'trace-abc',
      },
    });

    const rows = await db.query<{ correlation_id: string }>(
      'select correlation_id from wager_transactions where id = ?',
      [response.body.transactionId],
    );
    expect(rows[0]?.correlation_id).toBe('trace-abc');
    expect(response.headers.get('x-correlation-id')).toBe('trace-abc');
  });

  test('two simultaneous 80.00 bets on 100.00: one 201, one 422, balance 20.00', async () => {
    const wallet = await openWallet('100.00');
    const eighty = { money: { amount: '80.00', currency: 'BRL' } };

    const responses = await Promise.all([
      send(payload(wallet, eighty)),
      send(payload(wallet, eighty)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(await balanceOf(wallet.id)).toBe('20.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('transaction lookups', () => {
  test('GET /wagering/transactions/:id returns the transaction', async () => {
    const wallet = await openWallet('100.00');
    const body = payload(wallet);
    const submitted = await send(body);

    const response = await call(
      app,
      'GET',
      `/wagering/transactions/${submitted.body.transactionId}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: submitted.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
    });
  });

  test('GET by provider and external id returns the same transaction', async () => {
    const wallet = await openWallet('100.00');
    const body = payload(wallet);
    const submitted = await send(body);

    const response = await call(
      app,
      'GET',
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.transactionId).toBe(submitted.body.transactionId);
  });

  test('unknown transactions are 404 and a malformed id is 400', async () => {
    const byId = await call(app, 'GET', `/wagering/transactions/${randomUUID()}`);
    const byProvider = await call(app, 'GET', '/providers/provider-a/wagering/transactions/nope');
    const malformed = await call(app, 'GET', '/wagering/transactions/not-a-uuid');

    expect(byId.status).toBe(404);
    expect(byId.body.code).toBe('TRANSACTION_NOT_FOUND');
    expect(byProvider.status).toBe(404);
    expect(malformed.status).toBe(400);
  });
});

describe('ledger over HTTP', () => {
  test('pages through every entry with the cursor returned by the API', async () => {
    const wallet = await openWallet('100.00');
    for (const amount of ['1.00', '2.00', '3.00']) {
      await send(payload(wallet, { money: { amount, currency: 'BRL' } }));
    }

    const amounts: string[] = [];
    const pageSizes: number[] = [];
    let path = `/wallets/${wallet.id}/ledger?limit=2`;
    for (;;) {
      const page = await call(app, 'GET', path);
      pageSizes.push(page.body.items.length);
      amounts.push(
        ...page.body.items.map((item: { money: { amount: string } }) => item.money.amount),
      );
      if (page.body.nextCursor === null) break;
      path = `/wallets/${wallet.id}/ledger?limit=2&cursor=${page.body.nextCursor}`;
    }

    expect(pageSizes).toEqual([2, 2]);
    expect(amounts).toEqual(['100.00', '1.00', '2.00', '3.00']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
