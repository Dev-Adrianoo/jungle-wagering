// Pins the defenses of the pending-reference resolver that a sequential test cannot reach:
// the re-check after the lock, the wallet-first lock order, the retry of concurrency
// conflicts and the rule that metrics are recorded only after the commit. Gates hold one
// resolver at an exact point while another runs, so every interleaving is deterministic.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  StaleTransactionError,
  StaleWalletVersionError,
  UniqueViolationError,
} from '../../../src/application/errors';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import type { Metrics } from '../../../src/application/ports/metrics';
import type { TransactionRepository } from '../../../src/application/ports/transaction-repository';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import type { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { MutableClock } from '../../support/mutable-clock';
import { waitFor } from '../../support/wait-for';

let db: TestDatabase;
let clock: MutableClock;
let plain: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  clock = new MutableClock(new Date('2026-10-01T12:00:00.000Z'));
  plain = buildCore(db.orm, { lockTimeoutMs: 5000, clock });
});

afterAll(async () => {
  await db.drop();
});

interface LogLine {
  level: string;
  event: string;
  fields: LogFields | undefined;
}

function recordingLogger() {
  const lines: LogLine[] = [];
  const logger: Logger = {
    info: (event, fields) => void lines.push({ level: 'info', event, fields }),
    warn: (event, fields) => void lines.push({ level: 'warn', event, fields }),
    error: (event, fields) => void lines.push({ level: 'error', event, fields }),
  };
  return { lines, logger };
}

class RecordingMetrics implements Metrics {
  readonly recorded: Array<{ status: string; kind: string }> = [];

  transactionRecorded(status: string, kind: string): void {
    this.recorded.push({ status, kind });
  }
  duplicateDetected(): void {}
  idempotencyConflict(): void {}
  lockConflict(): void {}
  processingObserved(): void {}
  messageRetried(): void {}
  messageDeadLettered(): void {}
  outboxObserved(): void {}
  reconciliationDivergence(): void {}
}

function gate() {
  let release = () => {};
  let arrive = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    arrived,
    release,
    hold: async () => {
      arrive();
      await released;
    },
  };
}

interface Hooks {
  afterList?: (ids: string[]) => Promise<void>;
  afterLock?: (id: string) => Promise<void>;
  beforeUpdate?: (transaction: WagerTransaction) => Promise<void>;
}

function hooked(base: TransactionRepository, hooks: Hooks): TransactionRepository {
  return {
    insert: base.insert.bind(base),
    findById: base.findById.bind(base),
    findByIdempotencyKey: base.findByIdempotencyKey.bind(base),
    findByProviderAndExternalId: base.findByProviderAndExternalId.bind(base),
    isReversed: base.isReversed.bind(base),
    findDuePendingReferences: async (now, limit) => {
      const rows = await base.findDuePendingReferences(now, limit);
      await hooks.afterList?.(rows.map((row) => row.id));
      return rows;
    },
    findByIdForUpdate: async (id) => {
      const transaction = await base.findByIdForUpdate(id);
      await hooks.afterLock?.(id);
      return transaction;
    },
    update: async (transaction) => {
      await hooks.beforeUpdate?.(transaction);
      return base.update(transaction);
    },
  };
}

function observed(hooks: Hooks) {
  const { lines, logger } = recordingLogger();
  const metrics = new RecordingMetrics();
  const core = buildCore(db.orm, {
    lockTimeoutMs: 5000,
    clock,
    logger,
    metrics,
    decorateTransactions: (transactions) => hooked(transactions, hooks),
  });
  return { core, lines, metrics };
}

const failures = (lines: LogLine[]) =>
  lines.filter(
    (line) =>
      line.event === 'pending_reference.unexpected_failure' ||
      line.event === 'pending_reference.mark_failed_failed',
  );

const open = (amount: string) =>
  plain.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

async function submit(wallet: WalletView, overrides: Partial<WagerPayload> = {}) {
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
  return plain.submitWager.execute({
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    correlationId: 'corr-test',
    source: 'http',
  });
}

async function awaitingReversal(referenceArrives: boolean) {
  const wallet = await open('100.00');
  const betExternalId = `ext-${randomUUID()}`;
  const refund = await submit(wallet, {
    kind: 'REFUND',
    referenceExternalTransactionId: betExternalId,
  });
  if (referenceArrives) {
    await submit(wallet, { externalTransactionId: betExternalId });
  }
  clock.advanceSeconds(6);
  return { wallet, refundId: refund.transactionId };
}

const row = async (transactionId: string) =>
  (
    await db.query<{
      status: string;
      reference_attempts: number;
      next_attempt_at: Date | null;
    }>('select status, reference_attempts, next_attempt_at from wager_transactions where id = ?', [
      transactionId,
    ])
  )[0];
const eventsOf = async (transactionId: string) =>
  (
    await db.query<{ event_type: string }>(
      `select event_type from outbox_messages
       where payload -> 'data' ->> 'transactionId' = ? order by event_type`,
      [transactionId],
    )
  ).map((message) => message.event_type);
const ledgerRows = async (transactionId: string) =>
  db.query<{ wallet_version: number }>(
    'select wallet_version from wallet_ledger_entries where transaction_id = ?',
    [transactionId],
  );
const balanceOf = async (walletId: string) =>
  (await plain.walletQueries.getWallet(walletId)).balance.amount;

describe('a resolver held between listing and locking', () => {
  test('does not apply a reversal that another resolver already applied', async () => {
    const { wallet, refundId } = await awaitingReversal(true);
    const listed = gate();
    const slow = observed({
      afterList: async (ids) => {
        if (ids.includes(refundId)) {
          await listed.hold();
        }
      },
    });
    const fast = observed({});

    const held = slow.core.resolvePendingReferences.execute();
    await listed.arrived;
    await fast.core.resolvePendingReferences.execute();
    listed.release();
    await held;

    expect(await ledgerRows(refundId)).toHaveLength(1);
    expect(await eventsOf(refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const processed = (metrics: RecordingMetrics) =>
      metrics.recorded.filter((entry) => entry.kind === 'REFUND' && entry.status === 'PROCESSED');
    expect(processed(slow.metrics).length + processed(fast.metrics).length).toBe(1);
    expect(failures(slow.lines)).toEqual([]);
    expect(failures(fast.lines)).toEqual([]);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('does not count a second attempt for a missing reference', async () => {
    const { wallet, refundId } = await awaitingReversal(false);
    const listed = gate();
    const slow = observed({
      afterList: async (ids) => {
        if (ids.includes(refundId)) {
          await listed.hold();
        }
      },
    });
    const fast = observed({});
    const attemptedAt = clock.now();

    const held = slow.core.resolvePendingReferences.execute();
    await listed.arrived;
    await fast.core.resolvePendingReferences.execute();
    listed.release();
    await held;

    const after = await row(refundId);
    expect(after?.status).toBe('PENDING_REFERENCE');
    expect(after?.reference_attempts).toBe(1);
    expect(new Date(after?.next_attempt_at as Date).getTime()).toBe(attemptedAt.getTime() + 10_000);
    expect(failures(slow.lines)).toEqual([]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('a resolver held after it locked the wallet', () => {
  test('makes a competing BET on the same wallet wait for the reversal', async () => {
    const { wallet, refundId } = await awaitingReversal(true);
    const locked = gate();
    const slow = observed({
      afterLock: async (id) => {
        if (id === refundId) {
          await locked.hold();
        }
      },
    });

    const held = slow.core.resolvePendingReferences.execute();
    await locked.arrived;
    let bet: Promise<unknown> = Promise.resolve();
    try {
      bet = submit(wallet);
      await waitFor(
        async () =>
          (
            await db.query(
              `select 1 from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'`,
            )
          ).length > 0,
        { description: 'the BET to wait for the wallet lock' },
      );
    } finally {
      locked.release();
    }
    const betResult = (await bet) as { transactionId: string; status: string };
    await held;

    expect((await row(refundId))?.status).toBe('PROCESSED');
    expect(betResult.status).toBe('PROCESSED');
    const [reversal] = await ledgerRows(refundId);
    const [applied] = await ledgerRows(betResult.transactionId);
    expect((applied?.wallet_version as number) > (reversal?.wallet_version as number)).toBe(true);
    expect(slow.lines.filter((line) => line.level === 'error')).toEqual([]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('a concurrency conflict while resolving', () => {
  const conflicts: Array<[string, (walletId: string) => Error]> = [
    ['a stale wallet version', (walletId) => new StaleWalletVersionError(walletId)],
    ['a unique violation', () => new UniqueViolationError('ledger_wallet_version_unique')],
  ];

  for (const [name, makeError] of conflicts) {
    test(`${name} leaves the reversal waiting and it is resolved on the next cycle`, async () => {
      const { wallet, refundId } = await awaitingReversal(true);
      let thrown = false;
      const flaky = observed({
        beforeUpdate: async (transaction) => {
          if (transaction.id === refundId && !thrown) {
            thrown = true;
            throw makeError(wallet.id);
          }
        },
      });

      await flaky.core.resolvePendingReferences.execute();

      expect((await row(refundId))?.status).toBe('PENDING_REFERENCE');
      expect(flaky.lines.filter((line) => line.level === 'error')).toEqual([]);
      expect(
        flaky.lines.some(
          (line) =>
            line.level === 'warn' &&
            line.event === 'pending_reference.conflict' &&
            line.fields?.transactionId === refundId,
        ),
      ).toBe(true);
      expect(await eventsOf(refundId)).toEqual(['WagerTransactionPendingReference']);

      await flaky.core.resolvePendingReferences.execute();

      expect((await row(refundId))?.status).toBe('PROCESSED');
      expect(await eventsOf(refundId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      expect(await balanceOf(wallet.id)).toBe('100.00');
      await expectLedgerMatchesBalance(db, wallet.id);
    });
  }
});

describe('a transaction that someone else finished', () => {
  test('is skipped with a warning that names it', async () => {
    const { wallet, refundId } = await awaitingReversal(true);
    let thrown = false;
    const stale = observed({
      beforeUpdate: async (transaction) => {
        if (transaction.id === refundId && !thrown) {
          thrown = true;
          throw new StaleTransactionError(refundId);
        }
      },
    });

    await stale.core.resolvePendingReferences.execute();

    expect(
      stale.lines.some(
        (line) =>
          line.level === 'warn' &&
          line.event === 'pending_reference.stale' &&
          line.fields?.transactionId === refundId,
      ),
    ).toBe(true);
    expect(stale.lines.filter((line) => line.level === 'error')).toEqual([]);
    await plain.resolvePendingReferences.execute();
    expect((await row(refundId))?.status).toBe('PROCESSED');
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('observability of a resolution that does not commit', () => {
  test('records no transaction metric when the commit fails', async () => {
    const { wallet, refundId } = await awaitingReversal(true);
    await db.query(
      `create or replace function refuse_commit() returns trigger language plpgsql as
       $$ begin raise exception 'commit refused'; end $$`,
    );
    await db.query(
      `create constraint trigger refuse_commit_trg after update on wager_transactions
       deferrable initially deferred for each row
       when (new.id = '${refundId}') execute function refuse_commit()`,
    );
    const failing = observed({});

    try {
      await failing.core.resolvePendingReferences.execute();
    } finally {
      await db.query('drop trigger refuse_commit_trg on wager_transactions');
    }

    expect(failing.metrics.recorded).toEqual([]);
    expect(failing.lines.some((line) => line.event === 'wager.transaction')).toBe(false);
    expect((await row(refundId))?.status).toBe('PENDING_REFERENCE');
    expect(await ledgerRows(refundId)).toHaveLength(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
