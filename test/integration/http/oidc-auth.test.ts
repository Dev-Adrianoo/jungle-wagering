// The application is started in OIDC mode from configuration alone, with no adapter
// injected, against a key set served over HTTP by the test. Tokens are really signed and
// really verified; only the identity provider itself is replaced by this small server.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { call, startTestApp, type TestApp } from '../../support/http-app';
import { expectLedgerMatchesBalance } from '../../support/invariants';

const ISSUER = 'http://identity.test/realms/wagering';
const AUDIENCE = 'wagering-api';

let db: TestDatabase;
let app: TestApp;
let keyServer: ReturnType<typeof Bun.serve>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  keyServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ keys: [jwk] }),
  });
  db = await createTestDatabase();
  app = await startTestApp(
    db,
    {},
    {
      config: {
        authMode: 'oidc',
        oidc: {
          issuer: ISSUER,
          audience: AUDIENCE,
          jwksUrl: `http://127.0.0.1:${keyServer.port}/certs`,
        },
      },
    },
  );
});

afterAll(async () => {
  await app.close();
  await db.drop();
  await keyServer.stop(true);
});

function token(claims: Record<string, unknown>, audience = AUDIENCE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

const tokenOf = (role: string, providerId?: string) =>
  token({
    sub: `service-account-${role}`,
    realm_access: { roles: [role] },
    ...(providerId === undefined ? {} : { provider_id: providerId }),
  });

const authorized = async (role: string, providerId?: string) => ({
  authorization: `Bearer ${await tokenOf(role, providerId)}`,
});

async function openWallet(): Promise<{ id: string; playerId: string }> {
  const response = await call(app, 'POST', '/wallets', {
    body: { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    headers: await authorized('operator'),
  });
  expect(response.status).toBe(201);
  return response.body;
}

function bet(wallet: { id: string; playerId: string }, providerId = 'provider-a') {
  return {
    providerId,
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
}

const submit = (body: ReturnType<typeof bet>, headers: Record<string, string>) =>
  call(app, 'POST', '/wagering/transactions', {
    body,
    headers: { ...headers, 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` },
  });

const debitsOf = async (walletId: string) =>
  (
    await db.query(
      `select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [walletId],
    )
  ).length;

describe('OIDC mode', () => {
  test('health stays open without a token', async () => {
    expect((await call(app, 'GET', '/health/ready')).status).toBe(200);
  });

  test('a request without a token is 401', async () => {
    const response = await call(app, 'POST', '/wallets', {
      body: { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } },
    });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  test('a token for another audience is 401', async () => {
    const stranger = await token(
      { sub: 'x', realm_access: { roles: ['operator'] } },
      'another-api',
    );

    const response = await call(app, 'POST', '/wallets', {
      body: { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } },
      headers: { authorization: `Bearer ${stranger}` },
    });

    expect(response.status).toBe(401);
  });

  test('a provider token applies a bet for its own provider', async () => {
    const wallet = await openWallet();

    const response = await submit(bet(wallet), await authorized('provider', 'provider-a'));

    expect(response.status).toBe(201);
    expect(response.body.balance.amount).toBe('90.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a role that may not submit is 403 and nothing is debited', async () => {
    const wallet = await openWallet();

    const response = await submit(bet(wallet), await authorized('auditor'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(await debitsOf(wallet.id)).toBe(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a token bound to one provider cannot act for another', async () => {
    const wallet = await openWallet();

    const response = await submit(
      bet(wallet, 'provider-b'),
      await authorized('provider', 'provider-a'),
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PROVIDER_MISMATCH');
    expect(await debitsOf(wallet.id)).toBe(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('OIDC mode with the identity provider down', () => {
  test('a request with a token is 503, can be retried, and nothing is recorded', async () => {
    const wallet = await openWallet();
    const offline = await startTestApp(
      db,
      {},
      {
        queues: app.queues,
        config: {
          authMode: 'oidc',
          oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://127.0.0.1:9/certs' },
        },
      },
    );
    try {
      const body = bet(wallet);
      const response = await call(offline, 'POST', '/wagering/transactions', {
        body,
        headers: {
          ...(await authorized('provider', 'provider-a')),
          'idempotency-key': `provider-a:${body.externalTransactionId}`,
        },
      });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await debitsOf(wallet.id)).toBe(0);
      await expectLedgerMatchesBalance(db, wallet.id);
    } finally {
      await offline.close();
    }
  });
});
