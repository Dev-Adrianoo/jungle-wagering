import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/money/money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  type LedgerEntryState,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import { AT, brl, usd, WALLET_ID } from '../../support/builders';

const base = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: 'entry-1',
  walletId: WALLET_ID,
  transactionId: 'tx-1',
  walletVersion: 2,
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: AT,
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('accepts a balanced debit', () => {
    expect(WalletLedgerEntry.create(base()).isBalanced()).toBe(true);
  });

  test('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      base({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejects arithmetic that does not close', () => {
    expect(() => WalletLedgerEntry.create(base({ balanceAfter: brl('80.00') }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test('rejects a debit recorded with the credit arithmetic', () => {
    expect(() => WalletLedgerEntry.create(base({ balanceAfter: brl('125.00') }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test.each(['0', '-1.00'])('rejects a non-positive amount %s', (amount) => {
    expect(() => WalletLedgerEntry.create(base({ money: brl(amount) }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test('rejects negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create(
        base({ money: brl('150.00'), balanceBefore: brl('100.00'), balanceAfter: brl('-50.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a wallet version below 1', () => {
    expect(() => WalletLedgerEntry.create(base({ walletVersion: 0 }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create(base({ money: usd('25.00') }))).toThrow(
      CurrencyMismatchError,
    );
  });

  test('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(base());
    expect(() => {
      (entry as unknown as { direction: LedgerDirection }).direction = LedgerDirection.Credit;
    }).toThrow(TypeError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('rebuilds persisted state without validating it', () => {
    const entry = WalletLedgerEntry.rehydrate(base({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
