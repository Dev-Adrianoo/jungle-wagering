import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type { SubmitWagerCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';

let db: TestDatabase;
let core: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  core = buildCore(db.orm, { lockTimeoutMs: 10000 });
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
  };
}

const debitsOf = async (walletId: string) =>
  (
    await db.query<{ wallet_version: number }>(
      `select wallet_version from wallet_ledger_entries
       where wallet_id = ? and direction = 'DEBIT' order by seq`,
      [walletId],
    )
  ).map((row) => row.wallet_version);
const balanceOf = async (walletId: string) =>
  (await core.walletQueries.getWallet(walletId)).balance.amount;

describe('concurrent bets', () => {
  test('two 80.00 bets on a 100.00 wallet: one PROCESSED, one REJECTED, one debit', async () => {
    const wallet = await open('100.00');

    const results = await Promise.all([
      core.submitWager.execute(bet(wallet, '80.00')),
      core.submitWager.execute(bet(wallet, '80.00')),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(results.find((result) => result.status === 'REJECTED')?.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('the same bet sent 50 times in parallel debits exactly once', async () => {
    const wallet = await open('1000.00');
    const request = bet(wallet, '25.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => core.submitWager.execute(request)),
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    expect(results.every((result) => result.balance.amount === '975.00')).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('30 bets of 10.00 on a 100.00 wallet: exactly 10 win the balance', async () => {
    const wallet = await open('100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () => core.submitWager.execute(bet(wallet, '10.00'))),
    );

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(20);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await debitsOf(wallet.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => open('100.00')));

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => core.submitWager.execute(bet(wallet, '10.00'))),
      ),
    );

    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('50.00');
      expect(await debitsOf(wallet.id)).toHaveLength(5);
      await expectLedgerMatchesBalance(db, wallet.id);
    }
  });

  test('the same key with two different payloads in parallel: one wins, one conflicts', async () => {
    const wallet = await open('100.00');
    const first = bet(wallet, '10.00');
    const second = { ...bet(wallet, '11.00'), idempotencyKey: first.idempotencyKey };

    const results = await Promise.allSettled([
      core.submitWager.execute(first),
      core.submitWager.execute(second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
