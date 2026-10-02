import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  IdempotencyKeyConflictError,
  TransientInfrastructureError,
} from '../../../src/application/errors';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type { Logger } from '../../../src/application/ports/logger';
import type { Metrics } from '../../../src/application/ports/metrics';
import type { SubmitWagerCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { rejectionOf } from '../../support/rejection';

function throwingProxy<T extends object>(): T {
  return new Proxy({} as T, {
    get: () => () => {
      throw new Error('instrumentation exploded');
    },
  });
}

let db: TestDatabase;
let core: Core;
let hostile: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  core = buildCore(db.orm, { lockTimeoutMs: 10000 });
  hostile = buildCore(db.orm, {
    lockTimeoutMs: 10000,
    logger: throwingProxy<Logger>(),
    metrics: throwingProxy<Metrics>(),
  });
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

function bet(wallet: WalletView, amount: string): SubmitWagerCommand {
  const payload: WagerPayload = {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
  return {
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    correlationId: 'corr-test',
    source: 'http',
  };
}

describe('instrumentation never affects the transactional flow', () => {
  test('a logger and metrics that throw still return the committed bet', async () => {
    const wallet = await open('100.00');
    const command = bet(wallet, '30.00');

    const result = await hostile.submitWager.execute(command);

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    const rows = await db.query<{ count: string }>(
      'select count(*) as count from wager_transactions where external_transaction_id = ?',
      [command.payload.externalTransactionId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    expect((await core.walletQueries.getWallet(wallet.id)).balance.amount).toBe('70.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a failing bet surfaces its original error, not the instrumentation error', async () => {
    const wallet = await open('100.00');
    const command = bet(wallet, '10.00');
    await hostile.submitWager.execute(command);

    const error = await rejectionOf(
      hostile.submitWager.execute({
        ...command,
        payload: { ...command.payload, money: { amount: '11.00', currency: 'BRL' } },
      }),
    );

    expect(error).toBeInstanceOf(IdempotencyKeyConflictError);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('lock conflicts', () => {
  test('wallet_lock_conflicts_total counts a real lock timeout', async () => {
    const wallet = await open('100.00');
    const metrics = new PrometheusMetrics();
    const impatient = buildCore(db.orm, { lockTimeoutMs: 100, metrics });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = core.uow.run(async () => {
      await core.wallets.findByIdForUpdate(wallet.id);
      locked();
      await gate;
    });

    try {
      await holding;
      const error = await rejectionOf(impatient.submitWager.execute(bet(wallet, '10.00')));

      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect(await metrics.render()).toContain('wallet_lock_conflicts_total 1');
    } finally {
      release();
      await holder;
    }
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
