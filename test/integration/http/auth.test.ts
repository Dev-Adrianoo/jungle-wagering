import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { AuthGuard } from '../../../src/interface/http/auth/auth.guard';
import { ProblemDetailsFilter } from '../../../src/interface/http/problem-details.filter';
import { PROVIDER_IDENTITY_PORT } from '../../../src/interface/http/tokens';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { as, FakeIdentityAdapter } from '../../support/fake-identity-adapter';
import { call, startTestApp, type TestApp } from '../../support/http-app';

let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db, { identityPort: new FakeIdentityAdapter() });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

const walletBody = () => ({
  playerId: randomUUID(),
  initialBalance: { amount: '100.00', currency: 'BRL' },
});

async function openWallet() {
  const response = await call(app, 'POST', '/wallets', {
    body: walletBody(),
    headers: as('operator'),
  });
  return response.body as { id: string; playerId: string };
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

describe('authentication', () => {
  test('health endpoints stay open', async () => {
    expect((await call(app, 'GET', '/health/live')).status).toBe(200);
    expect((await call(app, 'GET', '/health/ready')).status).toBe(200);
  });

  test('a request without identity is 401', async () => {
    const response = await call(app, 'POST', '/wallets', { body: walletBody() });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });
});

describe('roles', () => {
  test('only an operator opens wallets', async () => {
    const asProvider = await call(app, 'POST', '/wallets', {
      body: walletBody(),
      headers: as('provider'),
    });
    const asAuditor = await call(app, 'POST', '/wallets', {
      body: walletBody(),
      headers: as('auditor'),
    });
    const asOperator = await call(app, 'POST', '/wallets', {
      body: walletBody(),
      headers: as('operator'),
    });

    expect(asProvider.status).toBe(403);
    expect(asProvider.body.code).toBe('FORBIDDEN');
    expect(asAuditor.status).toBe(403);
    expect(asOperator.status).toBe(201);
  });

  test('an auditor reads and reconciles but cannot submit transactions', async () => {
    const wallet = await openWallet();

    expect(
      (await call(app, 'GET', `/wallets/${wallet.id}`, { headers: as('auditor') })).status,
    ).toBe(200);
    expect(
      (await call(app, 'GET', `/wallets/${wallet.id}/ledger`, { headers: as('auditor') })).status,
    ).toBe(200);
    expect(
      (await call(app, 'POST', `/wallets/${wallet.id}/reconciliation`, { headers: as('auditor') }))
        .status,
    ).toBe(200);
    expect((await submit(bet(wallet), as('auditor'))).status).toBe(403);
  });

  test('a provider submits transactions but cannot read wallets', async () => {
    const wallet = await openWallet();

    expect((await submit(bet(wallet), as('provider', 'provider-a'))).status).toBe(201);
    expect(
      (await call(app, 'GET', `/wallets/${wallet.id}`, { headers: as('provider') })).status,
    ).toBe(403);
  });
});

describe('provider scope', () => {
  test('a provider cannot submit on behalf of another provider', async () => {
    const wallet = await openWallet();
    const body = bet(wallet, 'provider-b');

    const response = await submit(body, as('provider', 'provider-a'));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PROVIDER_MISMATCH');
    const rows = await db.query(
      'select id from wager_transactions where external_transaction_id = ?',
      [body.externalTransactionId],
    );
    expect(rows).toHaveLength(0);
  });

  test('a provider cannot look up transactions of another provider', async () => {
    const response = await call(app, 'GET', '/providers/provider-b/wagering/transactions/ext-1', {
      headers: as('provider', 'provider-a'),
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PROVIDER_MISMATCH');
  });

  test('a provider looks up its own transactions', async () => {
    const wallet = await openWallet();
    const body = bet(wallet);
    await submit(body, as('provider', 'provider-a'));

    const response = await call(
      app,
      'GET',
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      { headers: as('provider', 'provider-a') },
    );

    expect(response.status).toBe(200);
  });

  test('an operator is not bound to a provider', async () => {
    const response = await call(app, 'GET', '/providers/provider-b/wagering/transactions/ext-1', {
      headers: as('operator'),
    });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

@Controller('undecorated')
class UndecoratedController {
  @Get()
  index(): { reached: boolean } {
    return { reached: true };
  }
}

@Module({
  controllers: [UndecoratedController],
  providers: [
    { provide: PROVIDER_IDENTITY_PORT, useValue: new FakeIdentityAdapter() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class UndecoratedModule {}

describe('deny by default', () => {
  let bare: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    bare = await NestFactory.create(UndecoratedModule, { logger: false });
    bare.useGlobalFilters(new ProblemDetailsFilter());
    await bare.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(bare.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await bare.close();
  });

  test('a route with neither @Public() nor @Roles() is refused even with every role', async () => {
    const response = await fetch(`${baseUrl}/undecorated`, {
      headers: as('provider,operator,auditor'),
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('FORBIDDEN');
  });
});
