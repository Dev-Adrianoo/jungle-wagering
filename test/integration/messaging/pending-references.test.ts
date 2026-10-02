import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { MutableClock } from '../../support/mutable-clock';

let db: TestDatabase;
let clock: MutableClock;
let core: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  clock = new MutableClock(new Date('2026-10-01T12:00:00.000Z'));
  core = buildCore(db.orm, { lockTimeoutMs: 5000, clock });
});

afterAll(async () => {
  await db.drop();
});

const open = (amount: string) =>
  core.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

async function submit(using: Core, wallet: WalletView, overrides: Partial<WagerPayload> = {}) {
  const payload: WagerPayload = {
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
  const result = await using.submitWager.execute({
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    correlationId: 'corr-test',
    source: 'http',
  });
  return { payload, result };
}

const transactionRow = async (transactionId: string) =>
  (
    await db.query<{
      status: string;
      failure_code: string | null;
      reference_attempts: number;
      next_attempt_at: Date | null;
      reference_transaction_id: string | null;
    }>(
      `select status, failure_code, reference_attempts, next_attempt_at, reference_transaction_id
       from wager_transactions where id = ?`,
      [transactionId],
    )
  )[0];
const eventsOf = async (transactionId: string) =>
  (
    await db.query<{ event_type: string }>(
      `select event_type from outbox_messages
       where payload -> 'data' ->> 'transactionId' = ? order by event_type`,
      [transactionId],
    )
  ).map((row) => row.event_type);
const balanceOf = async (walletId: string) =>
  (await core.walletQueries.getWallet(walletId)).balance.amount;

async function pendingRefund(wallet: WalletView, referenceExternalTransactionId: string) {
  const { result } = await submit(core, wallet, {
    kind: 'REFUND',
    referenceExternalTransactionId,
  });
  expect(result.status).toBe(WagerTransactionStatus.PendingReference);
  return result.transactionId;
}

describe('ResolvePendingReferences', () => {
  test('applies a reversal once its reference has arrived', async () => {
    const wallet = await open('100.00');
    const betExternalId = `ext-${randomUUID()}`;
    const refundId = await pendingRefund(wallet, betExternalId);
    const { result: bet } = await submit(core, wallet, { externalTransactionId: betExternalId });
    clock.advanceSeconds(6);

    await core.resolvePendingReferences.execute();

    expect(await transactionRow(refundId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: bet.transactionId,
      next_attempt_at: null,
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await eventsOf(refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('leaves a transaction alone until its next attempt is due', async () => {
    const wallet = await open('100.00');
    const refundId = await pendingRefund(wallet, `ext-${randomUUID()}`);

    clock.advanceSeconds(2);
    await core.resolvePendingReferences.execute();

    expect(await transactionRow(refundId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
    });
  });

  test('a miss schedules the next attempt with backoff and emits no new event', async () => {
    const wallet = await open('100.00');
    const refundId = await pendingRefund(wallet, `ext-${randomUUID()}`);
    clock.advanceSeconds(6);
    const attemptedAt = clock.now();

    await core.resolvePendingReferences.execute();

    const row = await transactionRow(refundId);
    expect(row).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
    expect(new Date(row?.next_attempt_at as Date).getTime()).toBe(attemptedAt.getTime() + 10_000);
    expect(await eventsOf(refundId)).toEqual(['WagerTransactionPendingReference']);
  });

  test('gives up after the attempt limit with REFERENCE_NOT_FOUND', async () => {
    const wallet = await open('100.00');
    const refundId = await pendingRefund(wallet, `ext-${randomUUID()}`);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      clock.advanceSeconds(301);
      await core.resolvePendingReferences.execute();
    }

    expect(await transactionRow(refundId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 10,
      next_attempt_at: null,
    });
    expect(await eventsOf(refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a reference that arrives REJECTED rejects the reversal instead of leaving it stuck', async () => {
    const wallet = await open('10.00');
    const betExternalId = `ext-${randomUUID()}`;
    const refundId = await pendingRefund(wallet, betExternalId);
    await submit(core, wallet, {
      externalTransactionId: betExternalId,
      money: { amount: '25.00', currency: 'BRL' },
    });
    clock.advanceSeconds(6);

    await core.resolvePendingReferences.execute();

    expect(await transactionRow(refundId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect(await balanceOf(wallet.id)).toBe('10.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a rollback that would leave a negative balance is rejected with its own code', async () => {
    const wallet = await open('10.00');
    const winExternalId = `ext-${randomUUID()}`;
    const { result: rollback } = await submit(core, wallet, {
      kind: 'ROLLBACK',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: winExternalId,
    });
    await submit(core, wallet, {
      kind: 'WIN',
      externalTransactionId: winExternalId,
      money: { amount: '40.00', currency: 'BRL' },
    });
    await submit(core, wallet, { money: { amount: '45.00', currency: 'BRL' } });
    clock.advanceSeconds(6);

    await core.resolvePendingReferences.execute();

    expect(await transactionRow(rollback.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(await balanceOf(wallet.id)).toBe('5.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('two resolvers running together apply the reversal exactly once', async () => {
    const wallet = await open('100.00');
    const betExternalId = `ext-${randomUUID()}`;
    const refundId = await pendingRefund(wallet, betExternalId);
    await submit(core, wallet, { externalTransactionId: betExternalId });
    clock.advanceSeconds(6);
    const other = buildCore(db.orm, { lockTimeoutMs: 5000, clock });

    await Promise.all([
      core.resolvePendingReferences.execute(),
      other.resolvePendingReferences.execute(),
      core.resolvePendingReferences.execute(),
    ]);

    const credits = await db.query(
      `select id from wallet_ledger_entries where transaction_id = ?`,
      [refundId],
    );
    expect(credits).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('an unexpected permanent error marks the transaction FAILED and keeps it auditable', async () => {
    const wallet = await open('100.00');
    const betExternalId = `ext-${randomUUID()}`;
    const refundId = await pendingRefund(wallet, betExternalId);
    await submit(core, wallet, { externalTransactionId: betExternalId });
    clock.advanceSeconds(6);
    let breakNextInsert = true;
    const sabotaged = buildCore(db.orm, {
      lockTimeoutMs: 5000,
      clock,
      decorateOutbox: (outbox) => ({
        ...outbox,
        claimDue: outbox.claimDue.bind(outbox),
        save: outbox.save.bind(outbox),
        stats: outbox.stats.bind(outbox),
        insert: async (message) => {
          if (breakNextInsert) {
            breakNextInsert = false;
            throw new Error('unexpected bug while recording the event');
          }
          return outbox.insert(message);
        },
      }),
    });

    await sabotaged.resolvePendingReferences.execute();

    expect(await transactionRow(refundId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'INTERNAL_ERROR',
      next_attempt_at: null,
    });
    expect(await eventsOf(refundId)).toEqual([
      'WagerTransactionFailed',
      'WagerTransactionPendingReference',
    ]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
