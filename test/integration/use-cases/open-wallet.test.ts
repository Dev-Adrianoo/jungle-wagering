import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../../../src/application/errors';
import { buildCore, type Core } from '../../../src/composition/core';
import { NegativeInitialBalanceError } from '../../../src/domain/wallet/wallet';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
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

const open = (amount: string, playerId = randomUUID(), currency = 'BRL') =>
  core.openWallet.execute({
    playerId,
    initialBalance: { amount, currency },
    correlationId: 'corr-open',
  });

describe('OpenWallet', () => {
  test('creates the wallet at version 1 with the initial balance', async () => {
    const playerId = randomUUID();

    const wallet = await open('1000.00', playerId);

    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(await core.walletQueries.getWallet(wallet.id)).toEqual(wallet);
  });

  test('records the OPENING transaction, its credit and its events atomically', async () => {
    const wallet = await open('1000.00');

    const transactions = await db.query<{ kind: string; status: string; provider_id: string }>(
      'select kind, status, provider_id from wager_transactions where wallet_id = ?',
      [wallet.id],
    );
    const ledger = await core.walletQueries.getLedger(wallet.id, { cursor: undefined, limit: 50 });
    const events = await db.query<{ event_type: string }>(
      'select event_type from outbox_messages where aggregate_id = ? order by event_type',
      [wallet.id],
    );

    expect(transactions).toEqual([
      { kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal' },
    ]);
    expect(ledger.nextCursor).toBeNull();
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
    expect(events.map((row) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a zero initial balance creates no transaction, entry or event', async () => {
    const wallet = await open('0.00');

    const counts = await db.query<{ transactions: string; entries: string; events: string }>(
      `select
         (select count(*) from wager_transactions where wallet_id = ?) as transactions,
         (select count(*) from wallet_ledger_entries where wallet_id = ?) as entries,
         (select count(*) from outbox_messages where aggregate_id = ?) as events`,
      [wallet.id, wallet.id, wallet.id],
    );

    expect(wallet.version).toBe(1);
    expect(Number(counts[0]?.transactions)).toBe(0);
    expect(Number(counts[0]?.entries)).toBe(0);
    expect(Number(counts[0]?.events)).toBe(0);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a second wallet for the same player and currency is a conflict', async () => {
    const playerId = randomUUID();
    await open('10.00', playerId);

    expect(await rejectionOf(open('20.00', playerId))).toBeInstanceOf(WalletAlreadyExistsError);

    const wallets = await db.query('select id from wallets where player_id = ?', [playerId]);
    expect(wallets).toHaveLength(1);
  });

  test('the same player may hold wallets in different currencies', async () => {
    const playerId = randomUUID();
    await open('10.00', playerId, 'BRL');

    expect(await open('10.00', playerId, 'USD')).toMatchObject({
      balance: { amount: '10.00', currency: 'USD' },
    });
  });

  test('five simultaneous openings for the same player create exactly one wallet', async () => {
    const playerId = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => open('10.00', playerId)),
    );

    const created = results.filter((result) => result.status === 'fulfilled');
    const conflicts = results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof WalletAlreadyExistsError,
    );
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
  });

  test('refuses a negative initial balance', async () => {
    expect(await rejectionOf(open('-1.00'))).toBeInstanceOf(NegativeInitialBalanceError);
  });
});

describe('WalletQueries', () => {
  test('getWallet of an unknown wallet is not found', async () => {
    expect(await rejectionOf(core.walletQueries.getWallet(randomUUID()))).toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  test('getLedger of an unknown wallet is not found', async () => {
    expect(
      await rejectionOf(
        core.walletQueries.getLedger(randomUUID(), { cursor: undefined, limit: 50 }),
      ),
    ).toBeInstanceOf(WalletNotFoundError);
  });
});

describe('TransactionQueries', () => {
  test('finds the opening transaction by id and by provider', async () => {
    const wallet = await open('5.00');
    const rows = await db.query<{ id: string; external_transaction_id: string }>(
      'select id, external_transaction_id from wager_transactions where wallet_id = ?',
      [wallet.id],
    );
    const row = rows[0];
    if (!row) throw new Error('opening transaction missing');

    const byId = await core.transactionQueries.getById(row.id);
    const byProvider = await core.transactionQueries.getByProvider(
      'internal',
      row.external_transaction_id,
    );

    expect(byId).toMatchObject({
      transactionId: row.id,
      kind: 'OPENING',
      status: 'PROCESSED',
      balance: { amount: '5.00', currency: 'BRL' },
    });
    expect(byProvider).toEqual(byId);
  });
});
