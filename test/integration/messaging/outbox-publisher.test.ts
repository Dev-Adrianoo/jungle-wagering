import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { CrashPoint } from '../../../src/application/ports/crash-point';
import type { EventPublisher } from '../../../src/application/ports/event-publisher';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import { buildCore, type Core } from '../../../src/composition/core';
import type { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { SilentLogger } from '../../../src/infrastructure/observability/silent-logger';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { rejectionOf } from '../../support/rejection';
import { createTestQueues, type TestQueues } from '../../support/sqs';
import { waitFor } from '../../support/wait-for';

let db: TestDatabase;
let queues: TestQueues;
let real: SqsEventPublisher;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  real = new SqsEventPublisher(queues.client, queues.urls.events, new SilentLogger());
});

beforeEach(async () => {
  await db.query(
    'update outbox_messages set published_at = now(), next_attempt_at = null where published_at is null',
  );
  await queues.receiveAll(queues.urls.events, { waitSeconds: 0 });
});

afterAll(async () => {
  await queues.destroy();
  await db.drop();
});

function counting(publisher: EventPublisher) {
  const published = new Map<string, number>();
  const wrapped: EventPublisher = {
    publish: async (messages: readonly OutboxMessage[]) => {
      for (const message of messages) {
        published.set(message.id, (published.get(message.id) ?? 0) + 1);
      }
      return publisher.publish(messages);
    },
  };
  return { wrapped, published };
}

async function walletWithBets(core: Core, bets: number) {
  const wallet = await core.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount: '1000.00', currency: 'BRL' },
    correlationId: 'corr-open',
  });
  for (let index = 0; index < bets; index += 1) {
    const externalTransactionId = `ext-${randomUUID()}`;
    await core.submitWager.execute({
      idempotencyKey: `provider-a:${externalTransactionId}`,
      payload: {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
      correlationId: 'corr-bet',
      source: 'http',
    });
  }
  return wallet;
}

const pendingRows = () =>
  db.query<{ id: string; attempts: number; next_attempt_at: Date }>(
    'select id, attempts, next_attempt_at from outbox_messages where published_at is null',
  );
const allOutboxIds = async (walletId: string) =>
  (
    await db.query<{ id: string }>('select id from outbox_messages where aggregate_id = ?', [
      walletId,
    ])
  )
    .map((row) => row.id)
    .sort();

async function drain(core: Core): Promise<void> {
  let reserved = 1;
  while (reserved > 0) {
    reserved = await core.publishOutbox.execute();
  }
}

describe('PublishOutbox', () => {
  test('publishes every pending event with its envelope and marks it published', async () => {
    const core = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: real });
    const wallet = await walletWithBets(core, 3);

    await drain(core);

    const events = (await queues.receiveAll(queues.urls.events)).map((message) =>
      JSON.parse(message.body),
    );
    expect(events.map((event) => event.eventId).sort()).toEqual(await allOutboxIds(wallet.id));
    expect(events.every((event) => event.aggregateId === wallet.id)).toBe(true);
    expect(events.filter((event) => event.eventType === 'WalletBalanceChanged')).toHaveLength(4);
    expect(await pendingRows()).toHaveLength(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('two publishers running at the same time never publish the same event twice', async () => {
    const { wrapped, published } = counting(real);
    const first = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: wrapped });
    const second = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: wrapped });
    const wallet = await walletWithBets(first, 20);

    await Promise.all([drain(first), drain(second), drain(first), drain(second)]);

    expect([...published.keys()].sort()).toEqual(await allOutboxIds(wallet.id));
    expect([...published.values()].every((times) => times === 1)).toBe(true);
    expect(await pendingRows()).toHaveLength(0);
    expect(await queues.receiveAll(queues.urls.events)).toHaveLength(published.size);
  });

  test('when the events queue is unavailable the events stay pending and nothing else changes', async () => {
    const failing: EventPublisher = { publish: async () => new Set() };
    const core = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: failing });
    const wallet = await walletWithBets(core, 2);
    const before = Date.now();

    const reserved = await core.publishOutbox.execute();
    const reservedAgain = await core.publishOutbox.execute();

    const pending = await pendingRows();
    expect(reserved).toBe(6);
    expect(reservedAgain).toBe(0);
    expect(pending).toHaveLength(6);
    expect(pending.every((row) => row.attempts === 1)).toBe(true);
    expect(pending.every((row) => new Date(row.next_attempt_at).getTime() > before)).toBe(true);
    expect((await core.walletQueries.getWallet(wallet.id)).balance.amount).toBe('998.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a partial failure retries only the events that were not accepted', async () => {
    let refuseOne = true;
    const flaky: EventPublisher = {
      publish: async (messages) => {
        const accepted = await real.publish(refuseOne ? messages.slice(1) : messages);
        refuseOne = false;
        return accepted;
      },
    };
    const core = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: flaky });
    await walletWithBets(core, 1);

    await core.publishOutbox.execute();

    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBe(1);
  });

  test('a publisher holding a batch does not block another one, which publishes the remaining events', async () => {
    const { wrapped: realCounting, published } = counting(real);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldIds: string[] = [];
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const gated: EventPublisher = {
      publish: async (messages) => {
        heldIds = messages.map((message) => message.id);
        markHeld();
        await gate;
        return realCounting.publish(messages);
      },
    };
    const holder = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: gated });
    const other = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: realCounting });
    const wallet = await walletWithBets(holder, 8);
    const total = (await allOutboxIds(wallet.id)).length;

    const holderRun = holder.publishOutbox.execute();
    await held;
    const otherRun = drain(other);
    otherRun.catch(() => undefined);
    let otherError: unknown;
    let publishedWhileHeld: string[] = [];
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        otherRun,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('second publisher was blocked by the first')),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      publishedWhileHeld = [...published.keys()];
    } catch (error) {
      otherError = error;
    } finally {
      release();
    }
    await holderRun;

    expect(otherError).toBeUndefined();
    expect(heldIds).toHaveLength(10);
    expect(total).toBeGreaterThan(heldIds.length);
    expect(publishedWhileHeld).toHaveLength(total - heldIds.length);
    expect(publishedWhileHeld.some((id) => heldIds.includes(id))).toBe(false);
    expect([...published.keys()].sort()).toEqual(await allOutboxIds(wallet.id));
    expect([...published.values()].every((times) => times === 1)).toBe(true);
    expect(await pendingRows()).toHaveLength(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a crash after the send and before the mark leaves the events pending and they are sent again with the same ids', async () => {
    const { wrapped, published } = counting(real);
    let crashOnce = true;
    const crashPoint: CrashPoint = {
      reached(point) {
        if (point === 'outbox.after-publish-before-mark' && crashOnce) {
          crashOnce = false;
          throw new Error('simulated crash');
        }
      },
    };
    const core = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: wrapped, crashPoint });
    const wallet = await walletWithBets(core, 1);
    const ids = await allOutboxIds(wallet.id);

    const failure = await rejectionOf(core.publishOutbox.execute());

    expect((failure as Error).message).toBe('simulated crash');
    expect((await pendingRows()).map((row) => row.id).sort()).toEqual(ids);
    expect([...published.keys()].sort()).toEqual(ids);

    await drain(core);

    expect(await pendingRows()).toHaveLength(0);
    expect([...published.keys()].sort()).toEqual(ids);
    expect([...published.values()].every((times) => times === 2)).toBe(true);
    const delivered = (await queues.receiveAll(queues.urls.events)).map(
      (message) => JSON.parse(message.body).eventId,
    );
    expect([...new Set(delivered)].sort()).toEqual(ids);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a send to a queue that does not exist keeps the events pending, logs without the payload, and a later run delivers them', async () => {
    const logs: Array<{ event: string; fields?: LogFields }> = [];
    const capturing: Logger = {
      info: () => {},
      warn: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    };
    const broken = new SqsEventPublisher(
      queues.client,
      `${queues.urls.events}-does-not-exist`,
      capturing,
    );
    const failing = buildCore(db.orm, {
      lockTimeoutMs: 5000,
      publisher: broken,
      logger: capturing,
    });
    const wallet = await walletWithBets(failing, 1);
    const ids = await allOutboxIds(wallet.id);
    const before = Date.now();

    const reserved = await failing.publishOutbox.execute();

    const pending = await pendingRows();
    expect(reserved).toBe(ids.length);
    expect(pending.map((row) => row.id).sort()).toEqual(ids);
    expect(pending.every((row) => row.attempts === 1)).toBe(true);
    expect(pending.every((row) => new Date(row.next_attempt_at).getTime() > before)).toBe(true);
    expect(logs.some((entry) => entry.event === 'outbox.publish_failed')).toBe(true);
    expect(logs.filter((entry) => entry.event === 'outbox.retry_scheduled')).toHaveLength(
      ids.length,
    );
    expect(JSON.stringify(logs)).not.toContain('amount');
    expect(JSON.stringify(logs)).not.toContain(wallet.playerId);

    await db.query('update outbox_messages set next_attempt_at = now() where published_at is null');
    const healthy = buildCore(db.orm, { lockTimeoutMs: 5000, publisher: real });
    await waitFor(
      async () => {
        await healthy.publishOutbox.execute();
        return (await pendingRows()).length === 0;
      },
      { description: 'the pending events to be published' },
    );

    const delivered = (await queues.receiveAll(queues.urls.events)).map(
      (message) => JSON.parse(message.body).eventId,
    );
    expect(delivered.sort()).toEqual(ids);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('observe() reports how many events are pending and how old the oldest is', async () => {
    const metrics = new PrometheusMetrics();
    const core = buildCore(db.orm, { lockTimeoutMs: 5000, metrics });
    await walletWithBets(core, 1);

    await core.publishOutbox.observe();

    const text = await metrics.render();
    expect(text).toContain('outbox_pending 4');
    expect(text).toMatch(/outbox_lag_seconds \d/);
  });
});
