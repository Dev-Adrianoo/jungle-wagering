import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../src/application/ports/logger';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { call, startTestApp, type TestApp } from '../../support/http-app';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { createTestQueues, type TestQueues } from '../../support/sqs';
import { waitFor } from '../../support/wait-for';

let db: TestDatabase;
let queues: TestQueues;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  app = await startTestApp(db, {}, { queues, workers: true });
});

afterAll(async () => {
  await app.close();
  await queues.destroy();
  await db.drop();
});

async function openWallet(amount: string) {
  const response = await call(app, 'POST', '/wallets', {
    body: { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } },
  });
  return response.body as { id: string; playerId: string };
}

function message(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  const externalTransactionId = `ext-${randomUUID()}`;
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    correlationId: `trace-${randomUUID()}`,
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    },
  };
}

function recordingLogger() {
  const lines: Array<{ level: string; event: string }> = [];
  const logger: Logger = {
    info: (event) => void lines.push({ level: 'info', event }),
    warn: (event) => void lines.push({ level: 'warn', event }),
    error: (event) => void lines.push({ level: 'error', event }),
  };
  return { lines, logger };
}

const balanceOf = async (walletId: string) =>
  (await call(app, 'GET', `/wallets/${walletId}`)).body.balance.amount;
const unpublished = async (walletId: string) =>
  (
    await db.query(
      'select id from outbox_messages where aggregate_id = ? and published_at is null',
      [walletId],
    )
  ).length;

describe('a running instance', () => {
  test('takes a message from the queue, applies it and publishes its events', async () => {
    const wallet = await openWallet('100.00');
    const body = message(wallet);

    await queues.send(body, { groupId: wallet.id });

    await waitFor(async () => (await balanceOf(wallet.id)) === '75.00', {
      description: 'the bet to be applied',
    });
    await waitFor(async () => (await unpublished(wallet.id)) === 0, {
      description: 'the outbox to be published',
    });
    const events = (await queues.receiveAll(queues.urls.events)).map((received) =>
      JSON.parse(received.body),
    );
    const mine = events.filter((event) => event.aggregateId === wallet.id);
    expect(mine.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(mine.some((event) => event.correlationId === body.correlationId)).toBe(true);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('an HTTP transaction also has its events published by the worker', async () => {
    const wallet = await openWallet('100.00');
    const externalTransactionId = `ext-${randomUUID()}`;

    await call(app, 'POST', '/wagering/transactions', {
      body: message(wallet, { externalTransactionId, idempotencyKey: undefined }).data,
      headers: { 'idempotency-key': `provider-a:${externalTransactionId}` },
    });

    await waitFor(async () => (await unpublished(wallet.id)) === 0, {
      description: 'the outbox to be published',
    });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('resolves a pending reversal once its reference arrives', async () => {
    const wallet = await openWallet('100.00');
    const betExternalId = `ext-${randomUUID()}`;
    const refund = await call(app, 'POST', '/wagering/transactions', {
      body: message(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: betExternalId,
        idempotencyKey: undefined,
      }).data,
      headers: { 'idempotency-key': `provider-a:refund-${randomUUID()}` },
    });
    expect(refund.status).toBe(202);

    await queues.send(message(wallet, { externalTransactionId: betExternalId }), {
      groupId: wallet.id,
    });

    await waitFor(
      async () =>
        (
          await db.query(
            "select 1 from wager_transactions where wallet_id = ? and kind = 'REFUND' and status = 'PROCESSED'",
            [wallet.id],
          )
        ).length === 1,
      { timeoutMs: 30_000, description: 'the refund to be resolved by the worker' },
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('/metrics reports the outbox gauges', async () => {
    const text = await (await fetch(`${app.baseUrl}/metrics`)).text();
    expect(text).toMatch(/outbox_pending \d/);
    expect(text).toMatch(/outbox_lag_seconds \d/);
  });
});

describe('shutdown', () => {
  test('after close() the instance takes no more messages', async () => {
    const isolatedQueues = await createTestQueues();
    const isolated = await startTestApp(db, {}, { queues: isolatedQueues, workers: true });
    const wallet = await openWallet('100.00');

    await isolated.close();
    await isolatedQueues.send(message(wallet), { groupId: wallet.id });

    expect(await isolatedQueues.depth(isolatedQueues.urls.transactions)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await isolatedQueues.destroy();
  });

  test('close() while messages are flowing loses none and finishes inside the grace period', async () => {
    const isolatedQueues = await createTestQueues();
    const { lines, logger } = recordingLogger();
    const isolated = await startTestApp(db, { logger }, { queues: isolatedQueues, workers: true });
    const wallet = await openWallet('1000.00');
    const total = 8;
    for (let index = 0; index < total; index += 1) {
      await isolatedQueues.send(message(wallet), { groupId: wallet.id });
    }
    await waitFor(async () => (await balanceOf(wallet.id)) !== '1000.00', {
      description: 'the first bet to be applied',
    });

    const closingAt = Date.now();
    await isolated.close();

    expect(Date.now() - closingAt).toBeLessThan(15_000);
    const applied = (
      await db.query('select 1 from wallet_ledger_entries where wallet_id = ?', [wallet.id])
    ).length;
    const stillQueued = await isolatedQueues.depth(isolatedQueues.urls.transactions);
    expect(applied - 1 + stillQueued).toBe(total);
    expect(lines.map((line) => line.event)).toContain('workers.stopped');
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
    await expectLedgerMatchesBalance(db, wallet.id);
    await isolatedQueues.destroy();
  });

  test('close() is safe when the workers were never started', async () => {
    const idle = await startTestApp(db);

    await idle.close();
  });

  test('the HTTP port stops answering after close()', async () => {
    const closing = await startTestApp(db);
    await closing.close();

    const outcome = await fetch(`${closing.baseUrl}/health/live`).then(
      () => 'answered',
      () => 'refused',
    );

    expect(outcome).toBe('refused');
  });
});
