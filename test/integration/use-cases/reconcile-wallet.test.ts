import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WalletNotFoundError } from '../../../src/application/errors';
import { buildCore, type Core } from '../../../src/composition/core';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { rejectionOf } from '../../support/rejection';

let db: TestDatabase;
let core: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  core = buildCore(db.orm, { lockTimeoutMs: 3000 });
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

describe('ReconcileWallet', () => {
  test('reports a consistent wallet', async () => {
    const wallet = await open('975.00');

    expect(await core.reconcileWallet.execute(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  test('reports a divergence without fixing it', async () => {
    const wallet = await open('100.00');
    await db.query('update wallets set balance = balance + 1.50 where id = ?', [wallet.id]);

    const first = await core.reconcileWallet.execute(wallet.id);
    const second = await core.reconcileWallet.execute(wallet.id);

    expect(first).toMatchObject({
      storedBalance: { amount: '101.50', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '1.50', currency: 'BRL' },
      consistent: false,
    });
    expect(second).toEqual(first);
  });

  test('an unknown wallet is not found', async () => {
    expect(await rejectionOf(core.reconcileWallet.execute(randomUUID()))).toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
