import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EventPublisher } from '../../../src/application/ports/event-publisher';
import { buildCore, type Core } from '../../../src/composition/core';
import type { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { SilentLogger } from '../../../src/infrastructure/observability/silent-logger';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { createTestQueues, type TestQueues } from '../../support/sqs';

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
