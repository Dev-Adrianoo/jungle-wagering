import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import { currentLogContext } from '../../../src/infrastructure/observability/log-context';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { call, startTestApp, type TestApp } from '../../support/http-app';

interface Line extends LogFields {
  level: string;
  event: string;
}

const lines: Line[] = [];
const record =
  (level: string) =>
  (event: string, fields: LogFields = {}) => {
    lines.push({ level, event, ...currentLogContext(), ...fields });
  };
const recordingLogger: Logger = {
  info: record('info'),
  warn: record('warn'),
  error: record('error'),
};

let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db, { logger: recordingLogger });
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function openWallet(amount: string) {
  const response = await call(app, 'POST', '/wallets', {
    body: { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } },
  });
  return response.body as { id: string; playerId: string };
}

function bet(wallet: { id: string; playerId: string }, amount: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

const submit = (body: ReturnType<typeof bet>, correlationId: string) =>
  call(app, 'POST', '/wagering/transactions', {
    body,
    headers: {
      'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
      'x-correlation-id': correlationId,
    },
  });

const metricsText = async () => (await fetch(`${app.baseUrl}/metrics`)).text();

describe('GET /metrics', () => {
  test('is public and uses the Prometheus text format', async () => {
    const response = await fetch(`${app.baseUrl}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('# TYPE wager_transactions_total counter');
  });

  test('counts transactions by status, duplicates and conflicts', async () => {
    const wallet = await openWallet('100.00');
    const accepted = bet(wallet, '10.00');
    await submit(accepted, 'corr-m1');
    await submit(accepted, 'corr-m2');
    await submit({ ...accepted, money: { amount: '11.00', currency: 'BRL' } }, 'corr-m3');
    await submit(bet(wallet, '500.00'), 'corr-m4');

    const text = await metricsText();

    expect(text).toMatch(
      /wager_transactions_total\{status="PROCESSED",kind="BET",source="http"\} [1-9]/,
    );
    expect(text).toMatch(
      /wager_transactions_total\{status="REJECTED",kind="BET",source="http"\} [1-9]/,
    );
    expect(text).toMatch(/wager_duplicates_total\{source="http"\} [1-9]/);
    expect(text).toMatch(/wager_idempotency_conflicts_total [1-9]/);
    expect(text).toMatch(/wager_processing_duration_seconds_count\{source="http"\} [1-9]/);
  });

  test('counts a reconciliation divergence', async () => {
    const wallet = await openWallet('100.00');
    await db.query('update wallets set balance = balance + 1 where id = ?', [wallet.id]);

    await call(app, 'POST', `/wallets/${wallet.id}/reconciliation`);

    expect(await metricsText()).toMatch(/reconciliation_divergences_total [1-9]/);
    const divergence = lines.find((line) => line.event === 'reconciliation.divergence');
    expect(divergence).toMatchObject({ level: 'error', walletId: wallet.id });
  });
});

describe('structured logs', () => {
  test('a processed transaction is logged with every correlation field', async () => {
    const wallet = await openWallet('100.00');
    const body = bet(wallet, '10.00');

    const response = await submit(body, 'corr-log-1');

    const line = lines.find(
      (entry) => entry.event === 'wager.transaction' && entry.correlationId === 'corr-log-1',
    );
    expect(line).toMatchObject({
      level: 'info',
      correlationId: 'corr-log-1',
      transactionId: response.body.transactionId,
      walletId: wallet.id,
      providerId: 'provider-a',
      status: 'PROCESSED',
      kind: 'BET',
      source: 'http',
    });
  });

  test('no log line carries an amount, a balance or a payload', async () => {
    const wallet = await openWallet('31337.42');
    await submit(bet(wallet, '271.83'), 'corr-log-2');

    const everything = JSON.stringify(lines);

    expect(everything).not.toContain('31337.42');
    expect(everything).not.toContain('271.83');
    expect(everything).not.toContain('"money"');
    expect(everything).not.toContain('"amount"');
    expect(everything).not.toContain('"balance"');
  });

  test('parallel requests never mix correlation ids or transaction ids', async () => {
    const wallet = await openWallet('1000.00');
    const ids = Array.from({ length: 20 }, (_, index) => `corr-par-${index}-${randomUUID()}`);

    const responses = await Promise.all(ids.map((id) => submit(bet(wallet, '1.00'), id)));

    ids.forEach((id, index) => {
      const own = lines.filter(
        (line) => line.event === 'wager.transaction' && line.correlationId === id,
      );
      expect(own).toHaveLength(1);
      expect(own[0]?.transactionId).toBe(responses[index]?.body.transactionId);
      expect(own[0]?.walletId).toBe(wallet.id);
    });
  });

  test('every request leaves one access line with status and duration', async () => {
    await call(app, 'GET', '/health/live', { headers: { 'x-correlation-id': 'corr-access' } });

    const line = lines.find(
      (entry) => entry.event === 'http.request' && entry.correlationId === 'corr-access',
    );
    expect(line).toMatchObject({ method: 'GET', path: '/health/live', status: 200 });
    expect(typeof line?.durationMs).toBe('number');
  });
});
