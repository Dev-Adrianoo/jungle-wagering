import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/money/money';
import {
  InsufficientFundsError,
  NegativeInitialBalanceError,
  NonPositiveAmountError,
  Wallet,
} from '../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { AT, aWallet, brl, PLAYER_ID, usd, WALLET_ID } from '../../support/builders';

const LATER = new Date('2026-10-01T12:05:00.000Z');
const ref = (n: number) => ({ transactionId: `tx-${n}`, entryId: `entry-${n}`, at: LATER });

const open = (amount: string) =>
  Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: brl(amount),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: AT,
  });

describe('Wallet.open', () => {
  test('starts at version 1 with the opening credit recorded', () => {
    const { wallet, openingEntry } = open('1000.00');

    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  test('a zero initial balance produces no ledger entry', () => {
    const { wallet, openingEntry } = open('0');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('refuses a negative initial balance', () => {
    expect(() => open('-1.00')).toThrow(NegativeInitialBalanceError);
  });
});

describe('Wallet.debit', () => {
  test('lowers the balance, bumps the version and returns the matching entry', () => {
    const wallet = aWallet('100.00');

    const entry = wallet.debit(brl('80.00'), ref(1));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(LATER);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.id).toBe('entry-1');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });

  test('allows spending the whole balance', () => {
    const wallet = aWallet('100.00');
    wallet.debit(brl('100.00'), ref(1));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('refuses to go negative and leaves the wallet untouched', () => {
    const wallet = aWallet('20.00');

    expect(() => wallet.debit(brl('80.00'), ref(1))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(AT);
  });
});

describe('Wallet.credit', () => {
  test('raises the balance, bumps the version and returns the matching entry', () => {
    const wallet = aWallet('20.00');

    const entry = wallet.credit(brl('30.00'), ref(1));

    expect(wallet.balance.toJSON().amount).toBe('50.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe('20.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('50.00');
  });
});

describe('Wallet invariants', () => {
  test.each(['0', '-5.00'])('refuses a non-positive movement of %s', (amount) => {
    const wallet = aWallet('100.00');
    expect(() => wallet.debit(brl(amount), ref(1))).toThrow(NonPositiveAmountError);
    expect(() => wallet.credit(brl(amount), ref(1))).toThrow(NonPositiveAmountError);
    expect(wallet.version).toBe(1);
  });

  test('refuses a movement in another currency', () => {
    const wallet = aWallet('100.00');
    expect(() => wallet.debit(usd('1.00'), ref(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd('1.00'), ref(1))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('every balance change yields exactly one entry and one version step', () => {
    const wallet = aWallet('100.00');

    const entries = [
      wallet.debit(brl('10.00'), ref(1)),
      wallet.credit(brl('5.00'), ref(2)),
      wallet.debit(brl('95.00'), ref(3)),
    ];

    expect(entries.map((entry) => entry.walletVersion)).toEqual([2, 3, 4]);
    expect(wallet.version).toBe(4);
    expect(wallet.balance.isZero()).toBe(true);
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
  });
});
