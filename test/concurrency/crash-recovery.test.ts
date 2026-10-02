// Processes are stopped the hard way (a crash point armed through FAULT_CRASH_AT, or SIGKILL)
// while the others keep working. After each failure the surviving processes must finish the
// work, nothing may be lost and nothing may be applied twice. The graceful stop (SIGTERM) does
// not exist on Windows, so that test runs only on Linux (CI or the container). Every test ends
// by checking that each wallet balance equals the sum of its ledger.
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type Cluster, type Instance, startCluster } from '../support/cluster';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { expectLedgerMatchesBalance } from '../support/invariants';
import { createTestQueues, type TestQueues } from '../support/sqs';
import { waitFor } from '../support/wait-for';

let db: TestDatabase | undefined;
let queues: TestQueues | undefined;
let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.stopAll();
  await queues?.destroy();
  await db?.drop();
  cluster = undefined;
  queues = undefined;
  db = undefined;
});

async function environment(size: number, env: Record<string, string> = {}) {
  db = await createTestDatabase();
  queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
  cluster = await startCluster({ db, queues, size, env });
  return { db, queues, cluster };
}

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(target: Cluster, amount: string): Promise<Wallet> {
  const response = await target.post('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status, target.output()).toBe(201);
  return response.body;
}

function bet(wallet: Wallet, amount = '25.00') {
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

type Bet = ReturnType<typeof bet>;

function asMessage(data: Bet) {
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
  };
}

const pendingOutbox = async (target: TestDatabase) =>
  (await target.query('select id from outbox_messages where published_at is null')).length;

async function inboxCount(target: TestDatabase): Promise<number> {
  const [row] = await target.query<{ count: string }>(
    'select count(*) as count from inbox_messages',
  );
  return Number(row?.count ?? 0);
}

async function expectEveryEventDelivered(target: TestDatabase, source: TestQueues): Promise<void> {
  const expected = (await target.query<{ id: string }>('select id from outbox_messages'))
    .map((row) => row.id)
    .sort();
  const delivered = (await source.receiveAll(source.urls.events))
    .map((message) => JSON.parse(message.body).eventId as string)
    .sort();
  expect(delivered).toEqual(expected);
}

async function walletBalance(target: Cluster, wallet: Wallet): Promise<string> {
  return (await target.get(`/wallets/${wallet.id}`)).body.balance.amount;
}

describe('a worker killed after the commit and before the ack', () => {
  test('the message is redelivered to another instance, recognised by the inbox and has no second effect', async () => {
    const { db, queues, cluster } = await environment(1, { WORKERS_ENABLED: 'false' });
    const wallet = await openWallet(cluster, '100.00');
    const data = bet(wallet);
    const doomed = await cluster.add({
      WORKERS_ENABLED: 'true',
      FAULT_CRASH_AT: 'consumer.after-commit-before-ack',
    });

    await queues.send(asMessage(data), { groupId: wallet.id });

    expect(await doomed.exited, doomed.output()).toBe(137);
    const committed = await db.query(
      'select id from wager_transactions where external_transaction_id = ?',
      [data.externalTransactionId],
    );
    expect(committed).toHaveLength(1);
    expect(await queues.depth(queues.urls.transactions)).toBe(1);
    expect(doomed.output()).toContain('workers.fault_injection_armed');

    await cluster.add({ WORKERS_ENABLED: 'true' });
    await cluster.add({ WORKERS_ENABLED: 'true' });
    await waitFor(async () => (await queues.depth(queues.urls.transactions)) === 0, {
      timeoutMs: 30_000,
      description: () => `the redelivered message to be acknowledged\n${cluster.output()}`,
    });

    const debits = await db.query(
      `select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits).toHaveLength(1);
    expect(await inboxCount(db)).toBe(1);
    await waitFor(async () => cluster.entries('wager.duplicate_message').length === 1, {
      description: () => `the inbox to report the redelivery as a duplicate
${cluster.output()}`,
    });
    expect(cluster.entries('wager.replay')).toHaveLength(0);
    expect(await walletBalance(cluster, wallet)).toBe('75.00');
    expect(await queues.depth(queues.urls.deadLetter)).toBe(0);
    expect(cluster.errorLines()).toEqual([]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('a publisher killed after sending and before recording it', () => {
  test('another instance resends, and every event still arrives exactly once', async () => {
    const { db, queues, cluster } = await environment(1, { WORKERS_ENABLED: 'false' });
    const wallet = await openWallet(cluster, '100.00');
    const data = bet(wallet);
    await cluster.post('/wagering/transactions', data, {
      'idempotency-key': `provider-a:${data.externalTransactionId}`,
    });
    const expected = (await db.query<{ id: string }>('select id from outbox_messages'))
      .map((row) => row.id)
      .sort();

    const doomed = await cluster.add({
      WORKERS_ENABLED: 'true',
      FAULT_CRASH_AT: 'outbox.after-publish-before-mark',
    });
    expect(await doomed.exited, doomed.output()).toBe(137);
    expect(await pendingOutbox(db)).toBe(expected.length);

    await cluster.add({ WORKERS_ENABLED: 'true' });
    await waitFor(async () => (await pendingOutbox(db)) === 0, {
      timeoutMs: 30_000,
      description: () => `the outbox to be published after the crash\n${cluster.output()}`,
    });

    await expectEveryEventDelivered(db, queues);
    expect(cluster.errorLines()).toEqual([]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('a process killed in the middle of the work', () => {
  test('the survivors finish every message once and in order, and no event is lost', async () => {
    const { db, queues, cluster } = await environment(3);
    const wallets = await Promise.all(
      Array.from({ length: 12 }, () => openWallet(cluster, '1000.00')),
    );
    const amounts = Array.from({ length: 15 }, (_, index) => `${index + 1}.00`);
    const expectedMessages = wallets.length * amounts.length;
    const httpWallet = await openWallet(cluster, '1000.00');

    const sending = Promise.all(
      wallets.map(async (wallet) => {
        for (const amount of amounts) {
          await queues.send(asMessage(bet(wallet, amount)), { groupId: wallet.id });
        }
      }),
    );
    await waitFor(async () => (await inboxCount(db)) >= 20, {
      timeoutMs: 40_000,
      description: () => `the consumers to start working\n${cluster.output()}`,
    });
    const victim = cluster.instances[1] as Instance;
    await victim.kill();
    const appliedAtKill = await inboxCount(db);
    const http = await Promise.all(
      Array.from({ length: 30 }, () =>
        cluster.post('/wagering/transactions', bet(httpWallet, '1.00'), {
          'idempotency-key': `provider-a:http-${randomUUID()}`,
        }),
      ),
    );
    await sending;

    await waitFor(
      async () =>
        (await inboxCount(db)) === expectedMessages &&
        (await queues.depth(queues.urls.transactions)) === 0,
      {
        timeoutMs: 90_000,
        description: () => `the survivors to apply every message\n${cluster.output()}`,
      },
    );
    await waitFor(async () => (await pendingOutbox(db)) === 0, {
      timeoutMs: 40_000,
      description: () => `the survivors to publish the outbox\n${cluster.output()}`,
    });

    expect(appliedAtKill).toBeLessThan(expectedMessages);
    expect(http.every((response) => response.status === 201)).toBe(true);
    for (const wallet of wallets) {
      const entries = await db.query<{ amount: string }>(
        `select amount::text as amount from wallet_ledger_entries
         where wallet_id = ? and direction = 'DEBIT' order by seq`,
        [wallet.id],
      );
      expect(entries.map((entry) => entry.amount)).toEqual(amounts);
      expect(await walletBalance(cluster, wallet)).toBe('880.00');
      await expectLedgerMatchesBalance(db, wallet.id);
    }
    expect(await walletBalance(cluster, httpWallet)).toBe('970.00');
    await expectLedgerMatchesBalance(db, httpWallet.id);
    await expectEveryEventDelivered(db, queues);
    expect(await queues.depth(queues.urls.deadLetter)).toBe(0);
    expect(
      cluster.instances
        .filter((instance) => instance !== victim)
        .flatMap((instance) => instance.errorLines()),
    ).toEqual([]);
  });
});

describe('restart', () => {
  test('work left pending when every instance dies is finished after the restart', async () => {
    const { db, queues, cluster } = await environment(3, { WORKERS_ENABLED: 'false' });
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () => openWallet(cluster, '100.00')),
    );
    for (const wallet of wallets) {
      const data = bet(wallet, '10.00');
      await cluster.post('/wagering/transactions', data, {
        'idempotency-key': `provider-a:${data.externalTransactionId}`,
      });
    }
    expect(await pendingOutbox(db)).toBe(20);

    await cluster.stopAll();
    await Promise.all([
      cluster.add({ WORKERS_ENABLED: 'true' }),
      cluster.add({ WORKERS_ENABLED: 'true' }),
      cluster.add({ WORKERS_ENABLED: 'true' }),
    ]);

    await waitFor(async () => (await pendingOutbox(db)) === 0, {
      timeoutMs: 30_000,
      description: () => `the outbox to be published after the restart\n${cluster.output()}`,
    });
    await expectEveryEventDelivered(db, queues);
    for (const wallet of wallets) {
      expect(await walletBalance(cluster, wallet)).toBe('90.00');
      await expectLedgerMatchesBalance(db, wallet.id);
    }
  });
});

// Nest answers SIGTERM by running its shutdown hooks and then re-raising the signal, so a
// graceful end shows up as death by SIGTERM with no exit code. A request that was answered
// with 201 must be committed; one that was cut off may or may not be, but never half applied.
describe.skipIf(process.platform === 'win32')('graceful shutdown', () => {
  test('SIGTERM in the middle of the work loses nothing and applies nothing twice', async () => {
    const { db, queues, cluster } = await environment(3);
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => openWallet(cluster, '1000.00')),
    );
    const httpWallet = await openWallet(cluster, '1000.00');
    const amounts = Array.from({ length: 10 }, (_, index) => `${index + 1}.00`);
    const victim = cluster.instances[0] as Instance;

    const sending = Promise.all(
      wallets.map(async (wallet) => {
        for (const amount of amounts) {
          await queues.send(asMessage(bet(wallet, amount)), { groupId: wallet.id });
        }
      }),
    );
    await waitFor(async () => (await inboxCount(db)) >= 5, {
      timeoutMs: 40_000,
      description: () => `the consumers to start working\n${cluster.output()}`,
    });
    const direct = Array.from({ length: 30 }, () =>
      fetch(`${victim.url}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `provider-a:${randomUUID()}`,
        },
        body: JSON.stringify(bet(httpWallet, '1.00')),
      }).then(
        (response) => response.status,
        () => 0,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      victim.terminate().then(() => 'exited'),
      new Promise<string>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timeout'), 25_000);
      }),
    ]);
    clearTimeout(timer);
    const statuses = await Promise.all(direct);
    await sending;

    expect(exit, victim.output()).toBe('exited');
    expect(victim.exitInfo(), victim.output()).toEqual({ exitCode: null, signalCode: 'SIGTERM' });
    expect(victim.errorLines(), victim.output()).toEqual([]);
    expect(victim.entries().some((entry) => entry.event === 'workers.stopped')).toBe(true);
    await waitFor(
      async () =>
        (await inboxCount(db)) === wallets.length * amounts.length &&
        (await queues.depth(queues.urls.transactions)) === 0,
      {
        timeoutMs: 90_000,
        description: () => `the others to apply every message\n${cluster.output()}`,
      },
    );
    await waitFor(async () => (await pendingOutbox(db)) === 0, {
      timeoutMs: 40_000,
      description: () => `the outbox to be published\n${cluster.output()}`,
    });

    for (const wallet of wallets) {
      const entries = await db.query<{ amount: string }>(
        `select amount::text as amount from wallet_ledger_entries
         where wallet_id = ? and direction = 'DEBIT' order by seq`,
        [wallet.id],
      );
      expect(entries.map((entry) => entry.amount)).toEqual(amounts);
      await expectLedgerMatchesBalance(db, wallet.id);
    }
    const answered = statuses.filter((status) => status === 201).length;
    const cutOff = statuses.filter((status) => status === 0).length;
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    const [debits] = await db.query<{ count: string }>(
      `select count(*) as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [httpWallet.id],
    );
    expect(Number(debits?.count)).toBeGreaterThanOrEqual(answered);
    expect(Number(debits?.count)).toBeLessThanOrEqual(answered + cutOff);
    await expectLedgerMatchesBalance(db, httpWallet.id);
    await expectEveryEventDelivered(db, queues);
    expect(await queues.depth(queues.urls.deadLetter)).toBe(0);
  });
});
