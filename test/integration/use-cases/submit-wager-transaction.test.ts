import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type { SubmitWagerCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
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

const open = (amount: string) =>
  core.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });

function command(wallet: WalletView, overrides: Partial<WagerPayload> = {}): SubmitWagerCommand {
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
  return {
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    correlationId: 'corr-test',
    source: 'http',
  };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const submit = (wallet: WalletView, overrides: Partial<WagerPayload> = {}) =>
  core.submitWager.execute(command(wallet, overrides));
const balanceOf = async (walletId: string) =>
  (await core.walletQueries.getWallet(walletId)).balance.amount;
const directionsOf = async (walletId: string) =>
  (
    await db.query<{ direction: string }>(
      'select direction from wallet_ledger_entries where wallet_id = ? order by seq',
      [walletId],
    )
  ).map((row) => row.direction);
const eventsOf = async (walletId: string, transactionId: string) =>
  (
    await db.query<{ event_type: string }>(
      `select event_type from outbox_messages
       where aggregate_id = ? and payload -> 'data' ->> 'transactionId' = ?
       order by event_type`,
      [walletId, transactionId],
    )
  ).map((row) => row.event_type);

describe('BET', () => {
  test('debits the wallet and records transaction, ledger and events together', async () => {
    const wallet = await open('1000.00');

    const result = await submit(wallet);

    expect(result).toEqual({
      transactionId: result.transactionId,
      status: WagerTransactionStatus.Processed,
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT', 'DEBIT']);
    expect(await eventsOf(wallet.id, result.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect((await core.walletQueries.getWallet(wallet.id)).version).toBe(2);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('without enough balance is REJECTED and moves nothing', async () => {
    const wallet = await open('20.00');

    const result = await submit(wallet, { money: brl('80.00') });

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('20.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT']);
    expect(await eventsOf(wallet.id, result.transactionId)).toEqual(['WagerTransactionRejected']);
    expect((await core.walletQueries.getWallet(wallet.id)).version).toBe(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('for an unknown wallet is not found and persists nothing', async () => {
    const ghost: WalletView = { ...(await open('1.00')), id: randomUUID() };
    const request = command(ghost);

    expect(await rejectionOf(core.submitWager.execute(request))).toBeInstanceOf(
      WalletNotFoundError,
    );

    const rows = await db.query('select id from wager_transactions where idempotency_key = ?', [
      request.idempotencyKey,
    ]);
    expect(rows).toHaveLength(0);
  });

  test.each([
    ['another currency', { money: { amount: '5.00', currency: 'USD' } }, 'CURRENCY_MISMATCH'],
    ['another player', { playerId: randomUUID() }, 'PLAYER_WALLET_MISMATCH'],
  ])('with %s is REJECTED', async (_name, overrides, failureCode) => {
    const wallet = await open('100.00');

    const result = await submit(wallet, overrides);

    expect(result).toMatchObject({ status: 'REJECTED', failureCode });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('WIN and LOSS', () => {
  test('WIN credits the wallet', async () => {
    const wallet = await open('20.00');

    const result = await submit(wallet, { kind: 'WIN', money: brl('30.00') });

    expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('50.00') });
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT', 'CREDIT']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('WIN linked to its BET stores the internal reference', async () => {
    const wallet = await open('100.00');
    const bet = command(wallet);
    const betResult = await core.submitWager.execute(bet);

    const win = await submit(wallet, {
      kind: 'WIN',
      money: brl('40.00'),
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    const stored = await core.transactionQueries.getById(win.transactionId);
    expect(stored.referenceTransactionId).toBe(betResult.transactionId);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('LOSS is PROCESSED without ledger entry, balance change or version bump', async () => {
    const wallet = await open('20.00');

    const result = await submit(wallet, { kind: 'LOSS' });

    expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('20.00') });
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT']);
    expect(await eventsOf(wallet.id, result.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect((await core.walletQueries.getWallet(wallet.id)).version).toBe(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('REFUND and ROLLBACK', () => {
  async function walletWithBet(balance = '100.00', amount = '25.00') {
    const wallet = await open(balance);
    const bet = command(wallet, { money: brl(amount) });
    const betResult = await core.submitWager.execute(bet);
    return { wallet, bet, betResult };
  }

  test('REFUND credits back a processed BET', async () => {
    const { wallet, bet, betResult } = await walletWithBet();

    const result = await submit(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(
      (await core.transactionQueries.getById(result.transactionId)).referenceTransactionId,
    ).toBe(betResult.transactionId);
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a BET cannot be reversed twice, by the same kind or by another', async () => {
    const { wallet, bet } = await walletWithBet();
    const reference = { referenceExternalTransactionId: bet.payload.externalTransactionId };
    await submit(wallet, { kind: 'REFUND', ...reference });

    const secondRefund = await submit(wallet, { kind: 'REFUND', ...reference });
    const rollback = await submit(wallet, { kind: 'ROLLBACK', ...reference });

    expect(secondRefund).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect(rollback).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('ROLLBACK of a BET credits the wallet', async () => {
    const { wallet, bet } = await walletWithBet();

    const result = await submit(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('ROLLBACK of a WIN debits the wallet', async () => {
    const wallet = await open('10.00');
    const win = command(wallet, { kind: 'WIN', money: brl('40.00') });
    await core.submitWager.execute(win);

    const result = await submit(wallet, {
      kind: 'ROLLBACK',
      money: brl('40.00'),
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });

    expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('10.00') });
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('ROLLBACK that would leave a negative balance is REJECTED with its own code', async () => {
    const wallet = await open('10.00');
    const win = command(wallet, { kind: 'WIN', money: brl('40.00') });
    await core.submitWager.execute(win);
    await submit(wallet, { money: brl('45.00') });

    const result = await submit(wallet, {
      kind: 'ROLLBACK',
      money: brl('40.00'),
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });

    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: brl('5.00'),
    });
    expect(await balanceOf(wallet.id)).toBe('5.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('ROLLBACK of a REFUND debits again, and the BET cannot be refunded a second time', async () => {
    const { wallet, bet } = await walletWithBet();
    const refund = command(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });
    await core.submitWager.execute(refund);

    const rollback = await submit(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: refund.payload.externalTransactionId,
    });
    const refundAgain = await submit(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    expect(rollback).toMatchObject({ status: 'PROCESSED', balance: brl('75.00') });
    expect(refundAgain).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test.each([
    ['a different round', { roundId: 'round-2' }, 'REFERENCE_MISMATCH'],
    ['a different amount', { money: brl('24.99') }, 'REFERENCE_AMOUNT_MISMATCH'],
  ])('REFUND with %s is REJECTED', async (_name, overrides, failureCode) => {
    const { wallet, bet } = await walletWithBet();

    const result = await submit(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.payload.externalTransactionId,
      ...overrides,
    });

    expect(result).toMatchObject({ status: 'REJECTED', failureCode });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('REFUND of a WIN is REJECTED', async () => {
    const wallet = await open('10.00');
    const win = command(wallet, { kind: 'WIN', money: brl('40.00') });
    await core.submitWager.execute(win);

    const result = await submit(wallet, {
      kind: 'REFUND',
      money: brl('40.00'),
      referenceExternalTransactionId: win.payload.externalTransactionId,
    });

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
  });

  test('REFUND of a REJECTED BET is REJECTED', async () => {
    const wallet = await open('10.00');
    const bet = command(wallet, { money: brl('80.00') });
    await core.submitWager.execute(bet);

    const result = await submit(wallet, {
      kind: 'REFUND',
      money: brl('80.00'),
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('REFUND that arrives before its BET waits as PENDING_REFERENCE', async () => {
    const wallet = await open('100.00');

    const result = await submit(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'not-yet-here',
    });

    expect(result).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: brl('100.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await eventsOf(wallet.id, result.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('idempotency', () => {
  test('an identical retry returns the original result, including the balance seen then', async () => {
    const wallet = await open('1000.00');
    const request = command(wallet);
    const original = await core.submitWager.execute(request);
    await submit(wallet, { money: brl('100.00') });

    const replay = await core.submitWager.execute(request);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance).toEqual(brl('975.00'));
    expect(await balanceOf(wallet.id)).toBe('875.00');
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT', 'DEBIT', 'DEBIT']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a retry that only differs in amount formatting is still a replay', async () => {
    const wallet = await open('1000.00');
    const request = command(wallet, { money: brl('25.00') });
    await core.submitWager.execute(request);

    const replay = await core.submitWager.execute({
      ...request,
      payload: { ...request.payload, money: brl('25') },
    });

    expect(replay.idempotentReplay).toBe(true);
  });

  test('the same key with a different payload is a conflict, not a replay', async () => {
    const wallet = await open('1000.00');
    const request = command(wallet);
    await core.submitWager.execute(request);

    expect(
      await rejectionOf(
        core.submitWager.execute({
          ...request,
          payload: { ...request.payload, money: brl('26.00') },
        }),
      ),
    ).toBeInstanceOf(IdempotencyKeyConflictError);

    expect(await balanceOf(wallet.id)).toBe('975.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('the same provider transaction under another key is a conflict', async () => {
    const wallet = await open('1000.00');
    const request = command(wallet);
    await core.submitWager.execute(request);

    expect(
      await rejectionOf(
        core.submitWager.execute({ ...request, idempotencyKey: `other-${randomUUID()}` }),
      ),
    ).toBeInstanceOf(DuplicateExternalTransactionError);

    expect(await balanceOf(wallet.id)).toBe('975.00');
  });

  test('a rejected bet retried after the balance grew is still the original rejection', async () => {
    const wallet = await open('20.00');
    const request = command(wallet, { money: brl('80.00') });
    const original = await core.submitWager.execute(request);
    await submit(wallet, { kind: 'WIN', money: brl('500.00') });

    const replay = await core.submitWager.execute(request);

    expect(original.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance).toEqual(brl('20.00'));
    expect(await balanceOf(wallet.id)).toBe('520.00');
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT', 'CREDIT']);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('atomicity', () => {
  const brokenCore = () =>
    buildCore(db.orm, {
      lockTimeoutMs: 3000,
      outbox: {
        insert: async () => {
          throw new Error('outbox is down');
        },
        claimDue: async () => [],
        save: async () => {},
        stats: async () => ({ pending: 0, lagSeconds: 0 }),
      },
    });

  test('when the outbox write fails, nothing of the transaction is persisted', async () => {
    const wallet = await open('100.00');
    const request = command(wallet);

    const error = await rejectionOf(brokenCore().submitWager.execute(request));

    expect((error as Error).message).toContain('outbox is down');
    const rows = await db.query('select id from wager_transactions where idempotency_key = ?', [
      request.idempotencyKey,
    ]);
    expect(rows).toHaveLength(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await directionsOf(wallet.id)).toEqual(['CREDIT']);
    expect((await core.walletQueries.getWallet(wallet.id)).version).toBe(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('after the failure the same request can be retried and succeeds once', async () => {
    const wallet = await open('100.00');
    const request = command(wallet);
    const error = await rejectionOf(brokenCore().submitWager.execute(request));
    expect((error as Error).message).toContain('outbox is down');

    const retried = await core.submitWager.execute(request);

    expect(retried).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});

describe('ledger pagination', () => {
  test('walks every entry exactly once through an opaque cursor', async () => {
    const wallet = await open('100.00');
    for (const amount of ['1.00', '2.00', '3.00', '4.00']) {
      await submit(wallet, { money: brl(amount) });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await core.walletQueries.getLedger(wallet.id, { cursor, limit: 2 });
      seen.push(...page.items.map((item) => item.money.amount));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(['100.00', '1.00', '2.00', '3.00', '4.00']);
  });
});
