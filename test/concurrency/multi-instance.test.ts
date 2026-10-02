// Three real application processes share one PostgreSQL database and one set of SQS queues.
// HTTP requests are spread round-robin over the processes; every process also runs the SQS
// consumer, the outbox publisher and the pending-reference resolver. Each test ends by
// checking that the wallet balance equals the sum of its ledger.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type Cluster, startCluster } from '../support/cluster';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { expectLedgerMatchesBalance } from '../support/invariants';
import { createTestQueues, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

let db: TestDatabase;
let queues: TestQueues;
let cluster: Cluster;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues({ visibilityTimeoutSeconds: 5 });
  cluster = await startCluster({ db, queues, size: 3 });
});

afterAll(async () => {
  await cluster?.stopAll();
  await queues?.destroy();
  await db?.drop();
});

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(amount: string): Promise<Wallet> {
  const response = await cluster.post('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status, cluster.output()).toBe(201);
  return response.body;
}

function payload(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

type Payload = ReturnType<typeof payload>;

const idempotencyKeyOf = (body: Payload) => `${body.providerId}:${body.externalTransactionId}`;
const submit = (body: Payload) =>
  cluster.post('/wagering/transactions', body, { 'idempotency-key': idempotencyKeyOf(body) });
const balanceOf = async (walletId: string) =>
  (await cluster.get(`/wallets/${walletId}`)).body.balance.amount;
const debitsOf = async (walletId: string) =>
  (
    await db.query(
      `select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [walletId],
    )
  ).length;
const statusesOf = (responses: Array<{ status: number }>) =>
  responses.reduce<Record<number, number>>((counts, response) => {
    counts[response.status] = (counts[response.status] ?? 0) + 1;
    return counts;
  }, {});

function asMessage(data: Payload, messageId = `msg-${randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: idempotencyKeyOf(data) },
  };
}

function entriesAbout(event: string, walletIds: string[]) {
  return cluster.entries(event).filter((entry) => walletIds.includes(entry.walletId as string));
}

function instancesThatLogged(event: string, walletIds: string[]): number {
  return cluster.instances.filter((instance) =>
    instance
      .entries()
      .some((entry) => entry.event === event && walletIds.includes(entry.walletId as string)),
  ).length;
}

describe('three instances sharing one database', () => {
  test('every instance is up and ready', async () => {
    expect(cluster.instances).toHaveLength(3);
    for (const instance of cluster.instances) {
      expect((await fetch(`${instance.url}/health/ready`)).status).toBe(200);
    }
  });

  test('the same bet sent 60 times at once to the three instances debits exactly once', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);

    const responses = await Promise.all(Array.from({ length: 60 }, () => submit(body)));

    expect(statusesOf(responses), cluster.output()).toEqual({ 201: 1, 200: 59 });
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    await waitFor(
      async () =>
        entriesAbout('wager.replay', [wallet.id]).length === 59 &&
        entriesAbout('wager.transaction', [wallet.id]).length === 1,
      {
        description: () => `one transaction log line and 59 replay log lines
${cluster.output()}`,
      },
    );
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await debitsOf(wallet.id)).toBe(1);
    const stored = await db.query(
      "select id from wager_transactions where wallet_id = ? and kind = 'BET'",
      [wallet.id],
    );
    expect(stored).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('the same idempotency key with a different payload is a conflict on every instance', async () => {
    const wallet = await openWallet('1000.00');
    const body = payload(wallet);
    expect((await submit(body)).status).toBe(201);
    const tampered = { ...body, money: { amount: '99.00', currency: 'BRL' } };

    const responses = await Promise.all(
      Array.from({ length: 9 }, () =>
        cluster.post('/wagering/transactions', tampered, {
          'idempotency-key': idempotencyKeyOf(body),
        }),
      ),
    );

    expect(statusesOf(responses), cluster.output()).toEqual({ 409: 9 });
    expect(await balanceOf(wallet.id)).toBe('975.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('two 80.00 bets on 100.00 from different instances: one applied, one rejected', async () => {
    const wallet = await openWallet('100.00');
    const eighty = { money: { amount: '80.00', currency: 'BRL' } };

    const responses = await Promise.all([
      submit(payload(wallet, eighty)),
      submit(payload(wallet, eighty)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(responses.find((response) => response.status === 422)?.body.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await debitsOf(wallet.id)).toBe(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('90 bets of 10.00 on 100.00 spread over the instances: exactly 10 applied, 80 rejected', async () => {
    const wallet = await openWallet('100.00');
    const ten = { money: { amount: '10.00', currency: 'BRL' } };

    const responses = await Promise.all(
      Array.from({ length: 90 }, () => submit(payload(wallet, ten))),
    );

    expect(statusesOf(responses), cluster.output()).toEqual({ 201: 10, 422: 80 });
    expect(responses.length).toBe(90);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await debitsOf(wallet.id)).toBe(10);
    const negative = await db.query('select id from wallets where balance < 0');
    expect(negative).toHaveLength(0);
    await waitFor(async () => instancesThatLogged('wager.transaction', [wallet.id]) === 3, {
      description: () => `every instance to log a bet of this wallet
${cluster.output()}`,
    });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('different wallets are processed in parallel by different instances', async () => {
    const wallets = await Promise.all(Array.from({ length: 9 }, () => openWallet('100.00')));
    const ten = { money: { amount: '10.00', currency: 'BRL' } };

    const responses = await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 5 }, () => submit(payload(wallet, ten)))),
    );

    expect(statusesOf(responses), cluster.output()).toEqual({ 201: 45 });
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('50.00');
      await expectLedgerMatchesBalance(db, wallet.id);
    }
  });

  test('messages on the queue are consumed by three consumers, each applied once and in order per wallet', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet('1000.00')));
    const amounts = ['1.00', '2.00', '3.00', '4.00', '5.00', '6.00', '7.00', '8.00'];
    const walletIds = wallets.map((wallet) => wallet.id);
    const messageIds = new Set<string>();

    await Promise.all(
      wallets.map(async (wallet) => {
        for (const amount of amounts) {
          const message = asMessage(payload(wallet, { money: { amount, currency: 'BRL' } }));
          messageIds.add(message.messageId);
          await queues.send(message, { groupId: wallet.id });
          await queues.send(message, { groupId: wallet.id });
        }
      }),
    );

    await waitFor(
      async () => {
        const [row] = await db.query<{ count: string }>(
          'select count(*) as count from inbox_messages',
        );
        return Number(row?.count) === wallets.length * amounts.length &&
          (await queues.depth(queues.urls.transactions)) === 0
          ? true
          : undefined;
      },
      { timeoutMs: 60_000, description: () => `every message to be applied\n${cluster.output()}` },
    );

    for (const wallet of wallets) {
      const entries = await db.query<{ amount: string; direction: string }>(
        "select amount::text as amount, direction from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT' order by seq",
        [wallet.id],
      );
      expect(entries.map((entry) => entry.amount)).toEqual(amounts);
      expect(entries.every((entry) => entry.direction === 'DEBIT')).toBe(true);
      expect(await balanceOf(wallet.id)).toBe('964.00');
      await expectLedgerMatchesBalance(db, wallet.id);
    }
    await waitFor(
      async () =>
        entriesAbout('wager.transaction', walletIds).length === 64 &&
        cluster
          .entries('wager.duplicate_message')
          .filter((entry) => messageIds.has(entry.messageId as string)).length >= 64 &&
        instancesThatLogged('wager.transaction', walletIds) === 3,
      {
        description: () => `64 applied and 64 duplicate log lines, with every instance applying some
${cluster.output()}`,
      },
    );
    expect(await queues.depth(queues.urls.deadLetter)).toBe(0);
  });

  test('a REFUND that arrives on the queue before its BET is applied once the BET arrives', async () => {
    const wallet = await openWallet('100.00');
    const bet = payload(wallet);
    const refund = payload(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const statusOfRefund = async () =>
      (
        await cluster.get(
          `/providers/provider-a/wagering/transactions/${refund.externalTransactionId}`,
        )
      ).body?.status;

    await queues.send(asMessage(refund), { groupId: wallet.id });
    await waitFor(async () => (await statusOfRefund()) === 'PENDING_REFERENCE', {
      description: () => `the refund to be stored as pending\n${cluster.output()}`,
    });
    await queues.send(asMessage(bet), { groupId: wallet.id });

    await waitFor(async () => (await statusOfRefund()) === 'PROCESSED', {
      timeoutMs: 40_000,
      intervalMs: 500,
      description: () => `the refund to be applied\n${cluster.output()}`,
    });

    expect(await balanceOf(wallet.id)).toBe('100.00');
    const entries = await db.query<{ direction: string }>(
      'select direction from wallet_ledger_entries where wallet_id = ? order by seq',
      [wallet.id],
    );
    expect(entries.map((entry) => entry.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('three publishers on one outbox deliver every event, none lost, none published twice', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => openWallet('1000.00')));
    const one = { money: { amount: '1.00', currency: 'BRL' } };
    await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 30 }, () => submit(payload(wallet, one)))),
    );

    await waitFor(
      async () =>
        (await db.query('select id from outbox_messages where published_at is null')).length === 0,
      { timeoutMs: 40_000, description: () => `the outbox to be published\n${cluster.output()}` },
    );

    const expected = (await db.query<{ id: string }>('select id from outbox_messages'))
      .map((row) => row.id)
      .sort();
    const delivered = (await queues.receiveAll(queues.urls.events))
      .map((message) => JSON.parse(message.body).eventId as string)
      .sort();
    expect(delivered).toEqual(expected);
    expect(new Set(delivered).size).toBe(delivered.length);
    const resent = await db.query('select id from outbox_messages where attempts > 0');
    expect(resent).toHaveLength(0);
    for (const wallet of wallets) {
      await expectLedgerMatchesBalance(db, wallet.id);
    }
  });

  test('no instance logged an error and the dead-letter queue is empty', async () => {
    expect(cluster.errorLines()).toEqual([]);
    expect(await queues.depth(queues.urls.deadLetter)).toBe(0);
    for (const instance of cluster.instances) {
      expect(instance.exitInfo()).toEqual({ exitCode: null, signalCode: null });
    }
  });
});
