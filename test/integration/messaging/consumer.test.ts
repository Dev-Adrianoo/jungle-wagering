import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransientInfrastructureError } from '../../../src/application/errors';
import type { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { SilentLogger } from '../../../src/infrastructure/observability/silent-logger';
import { NoopCrashPoint } from '../../../src/infrastructure/system/noop-crash-point';
import { SqsWagerConsumer } from '../../../src/interface/workers/sqs-wager-consumer';
import { WagerMessageHandler } from '../../../src/interface/workers/wager-message-handler';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { createTestQueues, type TestQueues } from '../../support/sqs';
import { waitFor } from '../../support/wait-for';

let db: TestDatabase;
let core: Core;
let queues: TestQueues;
let metrics: PrometheusMetrics;
let consumer: SqsWagerConsumer | undefined;

beforeAll(async () => {
  db = await createTestDatabase();
  metrics = new PrometheusMetrics();
  core = buildCore(db.orm, { lockTimeoutMs: 5000, metrics });
  queues = await createTestQueues({ visibilityTimeoutSeconds: 30 });
});

afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  await queues.receiveAll(queues.urls.transactions, { waitSeconds: 0 });
  await queues.receiveAll(queues.urls.deadLetter, { waitSeconds: 0 });
});

afterAll(async () => {
  await queues.destroy();
  await db.drop();
});

function startConsumer(
  submitWager: Pick<SubmitWagerTransaction, 'executeFromMessage'> = core.submitWager,
) {
  consumer = new SqsWagerConsumer({
    client: queues.client,
    urls: queues.urls,
    handler: new WagerMessageHandler(submitWager, new SilentLogger()),
    metrics,
    logger: new SilentLogger(),
    crashPoint: new NoopCrashPoint(),
    options: { waitTimeSeconds: 1, batchSize: 10, baseBackoffSeconds: 0, maxBackoffSeconds: 0 },
  });
  consumer.start();
}

const open = (amount: string) =>
  core.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

function message(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  const externalTransactionId = `ext-${randomUUID()}`;
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
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

const balanceOf = async (walletId: string) =>
  (await core.walletQueries.getWallet(walletId)).balance.amount;
const queueIsEmpty = () =>
  waitFor(async () => (await queues.depth(queues.urls.transactions)) === 0, {
    description: 'the transactions queue to drain',
  });
const deadLetters = async () => {
  await waitFor(async () => (await queues.depth(queues.urls.deadLetter)) > 0, {
    description: 'a dead-lettered message',
  });
  return queues.receiveAll(queues.urls.deadLetter);
};
const transactionsFor = (wallet: WalletView) =>
  db.query<{ status: string; failure_code: string | null }>(
    `select status, failure_code from wager_transactions where wallet_id = ? and kind <> 'OPENING'`,
    [wallet.id],
  );

describe('SqsWagerConsumer', () => {
  test('processes a message and removes it from the queue only after it is applied', async () => {
    const wallet = await open('100.00');
    startConsumer();

    await queues.send(message(wallet), { groupId: wallet.id });
    await queueIsEmpty();

    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await transactionsFor(wallet)).toEqual([{ status: 'PROCESSED', failure_code: null }]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a message delivered twice debits once', async () => {
    const wallet = await open('100.00');
    const body = message(wallet);
    startConsumer();

    await queues.send(body, { groupId: wallet.id });
    await queues.send(body, { groupId: wallet.id });
    await queueIsEmpty();

    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await transactionsFor(wallet)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a business rejection is acknowledged and stays auditable', async () => {
    const wallet = await open('10.00');
    startConsumer();

    await queues.send(message(wallet, { money: { amount: '80.00', currency: 'BRL' } }), {
      groupId: wallet.id,
    });
    await queueIsEmpty();

    expect(await transactionsFor(wallet)).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    expect(await queues.depth(queues.urls.deadLetter)).toBe(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test.each([
    ['a body that is not JSON', () => 'not json at all'],
    ['an envelope without type', (wallet: WalletView) => ({ ...message(wallet), type: undefined })],
    ['kind OPENING', (wallet: WalletView) => message(wallet, { kind: 'OPENING' })],
  ])('%s goes to the dead-letter queue and persists nothing', async (_name, build) => {
    const wallet = await open('100.00');
    startConsumer();

    await queues.send(build(wallet), { groupId: wallet.id });
    const dead = await deadLetters();

    expect(dead).toHaveLength(1);
    expect(dead[0]?.attributes.reason).toBe('INVALID_MESSAGE');
    expect(await queues.depth(queues.urls.transactions)).toBe(0);
    expect(await transactionsFor(wallet)).toHaveLength(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('a message for an unknown wallet is dead-lettered and does not block the next one', async () => {
    const wallet = await open('100.00');
    const ghost = { id: randomUUID(), playerId: randomUUID() };
    startConsumer();

    await queues.send(message(ghost), { groupId: 'shared-group' });
    await queues.send(message(wallet), { groupId: 'shared-group' });
    const dead = await deadLetters();
    await queueIsEmpty();

    expect(dead[0]?.attributes.reason).toBe('WALLET_NOT_FOUND');
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a message id reused with another payload is dead-lettered without a second effect', async () => {
    const wallet = await open('100.00');
    const first = message(wallet);
    const forged = { ...message(wallet), messageId: first.messageId };
    startConsumer();

    await queues.send(first, { groupId: wallet.id });
    await queueIsEmpty();
    await queues.send(forged, { groupId: wallet.id });
    const dead = await deadLetters();

    expect(dead[0]?.attributes.reason).toBe('MESSAGE_ID_REUSED');
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await transactionsFor(wallet)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a transient failure is retried until it succeeds, with one effect', async () => {
    const wallet = await open('100.00');
    let failuresLeft = 2;
    startConsumer({
      executeFromMessage: async (command, inbox) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new TransientInfrastructureError('database is temporarily unavailable');
        }
        return core.submitWager.executeFromMessage(command, inbox);
      },
    });

    await queues.send(message(wallet), { groupId: wallet.id });
    await queueIsEmpty();

    expect(failuresLeft).toBe(0);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await metrics.render()).toMatch(/sqs_retries_total [2-9]/);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a message that keeps failing is dead-lettered once the receive limit is reached', async () => {
    const wallet = await open('100.00');
    let attempts = 0;
    startConsumer({
      executeFromMessage: async () => {
        attempts += 1;
        throw new TransientInfrastructureError('database is temporarily unavailable');
      },
    });

    await queues.send(message(wallet), { groupId: wallet.id });
    const dead = await deadLetters();

    expect(dead[0]?.attributes.reason).toBe('RETRIES_EXHAUSTED');
    expect(attempts).toBe(5);
    expect(await queues.depth(queues.urls.transactions)).toBe(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('stop() finishes the message in flight and leaves later messages on the queue', async () => {
    const wallet = await open('100.00');
    startConsumer();
    await queues.send(message(wallet), { groupId: wallet.id });
    await queueIsEmpty();

    await consumer?.stop();
    consumer = undefined;
    await queues.send(message(wallet), { groupId: wallet.id });

    expect(await queues.depth(queues.urls.transactions)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });
});
