import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { defaultPolicies } from '../../../src/domain/wagering/policies/default-policies';
import { WagerProcessor } from '../../../src/domain/wagering/wager-processor';
import {
  InvalidWagerTransactionError,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { AT, aProcessed, aTransaction, aWallet, brl, usd } from '../../support/builders';

const NOW = new Date('2026-10-01T12:00:10.000Z');
const processor = new WagerProcessor(defaultPolicies());

function run(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
) {
  return processor.process({
    transaction,
    wallet,
    reference,
    referenceAlreadyReversed,
    entryId: 'entry-1',
    now: NOW,
  });
}

const refund = (overrides = {}) =>
  aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-ref', ...overrides });
const rollback = (overrides = {}) =>
  aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-ref', ...overrides });

describe('BET', () => {
  test('debits the wallet and is PROCESSED', () => {
    const wallet = aWallet('100.00');
    const tx = aTransaction({ money: brl('80.00') });

    const entry = run(tx, wallet);

    expect(tx.status).toBe(Status.Processed);
    expect(tx.observedBalance.toJSON().amount).toBe('20.00');
    expect(tx.processedAt).toEqual(NOW);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.id).toBe('entry-1');
    expect(entry?.transactionId).toBe(tx.id);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('is REJECTED with INSUFFICIENT_FUNDS and leaves no ledger entry', () => {
    const wallet = aWallet('20.00');
    const tx = aTransaction({ money: brl('80.00') });

    const entry = run(tx, wallet);

    expect(entry).toBeUndefined();
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance.toJSON().amount).toBe('20.00');
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });
});

describe('WIN', () => {
  test('credits the wallet without a reference', () => {
    const wallet = aWallet('20.00');
    const tx = aTransaction({ kind: Kind.Win, money: brl('30.00') });

    const entry = run(tx, wallet);

    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('50.00');
  });

  test('links to the BET of the same round when a reference is given', () => {
    const tx = aTransaction({
      kind: Kind.Win,
      money: brl('30.00'),
      referenceExternalTransactionId: 'ext-ref',
    });

    run(tx, aWallet('20.00'), aProcessed({ kind: Kind.Bet }));

    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-ref');
  });

  test('waits when the declared reference has not arrived', () => {
    const wallet = aWallet('20.00');
    const tx = aTransaction({ kind: Kind.Win, referenceExternalTransactionId: 'ext-ref' });

    const entry = run(tx, wallet);

    expect(entry).toBeUndefined();
    expect(tx.status).toBe(Status.PendingReference);
    expect(wallet.version).toBe(1);
  });

  test('is REJECTED when the reference is not a BET', () => {
    const tx = aTransaction({ kind: Kind.Win, referenceExternalTransactionId: 'ext-ref' });

    run(tx, aWallet('20.00'), aProcessed({ kind: Kind.Win }));

    expect(tx.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });
});

describe('LOSS', () => {
  test('is PROCESSED without touching balance, version or ledger', () => {
    const wallet = aWallet('20.00');
    const tx = aTransaction({ kind: Kind.Loss });

    const entry = run(tx, wallet);

    expect(entry).toBeUndefined();
    expect(tx.status).toBe(Status.Processed);
    expect(tx.observedBalance.toJSON().amount).toBe('20.00');
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('credits back a PROCESSED BET', () => {
    const wallet = aWallet('75.00');
    const tx = refund();

    const entry = run(tx, wallet, aProcessed({ kind: Kind.Bet }));

    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('waits when the reference has not arrived', () => {
    const tx = refund();

    expect(run(tx, aWallet('75.00'))).toBeUndefined();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.nextAttemptAt).toEqual(new Date(NOW.getTime() + 5000));
  });

  test.each([
    ['a different round', { roundId: 'round-2' }, FailureCode.ReferenceMismatch],
    ['a different wallet', { walletId: 'other-wallet' }, FailureCode.ReferenceMismatch],
    ['a different player', { playerId: 'other-player' }, FailureCode.ReferenceMismatch],
    ['a different currency', { money: usd('25.00') }, FailureCode.ReferenceMismatch],
    ['a WIN', { kind: Kind.Win }, FailureCode.ReferenceKindNotAllowed],
    ['a different amount', { money: brl('24.99') }, FailureCode.ReferenceAmountMismatch],
    [
      'a REJECTED transaction',
      {
        status: Status.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        processedAt: undefined,
      },
      FailureCode.ReferenceNotProcessed,
    ],
  ])('is REJECTED when the reference is %s', (_name, referenceOverrides, expected) => {
    const wallet = aWallet('75.00');
    const tx = refund();

    const entry = run(tx, wallet, aProcessed(referenceOverrides));

    expect(entry).toBeUndefined();
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(expected);
    expect(wallet.version).toBe(1);
  });

  test('is REJECTED when the reference was already reversed', () => {
    const tx = refund();

    run(tx, aWallet('75.00'), aProcessed({ kind: Kind.Bet }), true);

    expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits the wallet', () => {
    const wallet = aWallet('75.00');
    const entry = run(rollback(), wallet, aProcessed({ kind: Kind.Bet }));

    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('of a WIN debits the wallet', () => {
    const wallet = aWallet('75.00');
    const entry = run(rollback(), wallet, aProcessed({ kind: Kind.Win }));

    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('50.00');
  });

  test('of a REFUND debits the wallet', () => {
    const wallet = aWallet('75.00');
    const reference = aProcessed({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });

    const entry = run(rollback(), wallet, reference);

    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('50.00');
  });

  test('that would leave a negative balance is REJECTED with its own code', () => {
    const wallet = aWallet('10.00');
    const tx = rollback();

    const entry = run(tx, wallet, aProcessed({ kind: Kind.Win }));

    expect(entry).toBeUndefined();
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('cannot reverse another ROLLBACK', () => {
    const tx = rollback();
    const reference = aProcessed({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'ext-bet',
    });

    run(tx, aWallet('75.00'), reference);

    expect(tx.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('waits while its reference is itself waiting', () => {
    const tx = rollback();
    const reference = aProcessed({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ext-bet',
      status: Status.PendingReference,
      processedAt: undefined,
      nextAttemptAt: AT,
    });

    run(tx, aWallet('75.00'), reference);

    expect(tx.status).toBe(Status.PendingReference);
  });

  test('is REJECTED when the reference was already reversed', () => {
    const tx = rollback();

    run(tx, aWallet('75.00'), aProcessed({ kind: Kind.Bet }), true);

    expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });
});

describe('checks shared by every kind', () => {
  test('a currency different from the wallet is REJECTED with CURRENCY_MISMATCH', () => {
    const wallet = aWallet('100.00');
    const tx = aTransaction({ money: usd('10.00') });

    const entry = run(tx, wallet);

    expect(entry).toBeUndefined();
    expect(tx.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.version).toBe(1);
  });

  test('a player that does not own the wallet is REJECTED with PLAYER_WALLET_MISMATCH', () => {
    const tx = aTransaction({ playerId: 'someone-else' });

    run(tx, aWallet('100.00'));

    expect(tx.failureCode).toBe(FailureCode.PlayerWalletMismatch);
  });

  test('OPENING cannot go through the processor', () => {
    const tx = aTransaction({ kind: Kind.Opening, roundId: undefined, gameId: undefined });
    expect(() => run(tx, aWallet('100.00'))).toThrow(InvalidWagerTransactionError);
  });
});

describe('reprocessing a PENDING_REFERENCE transaction', () => {
  test('a new miss schedules the next retry', () => {
    const wallet = aWallet('75.00');
    const tx = refund();
    run(tx, wallet);

    run(tx, wallet);

    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(new Date(NOW.getTime() + 10000));
  });

  test('is applied once the reference shows up', () => {
    const wallet = aWallet('75.00');
    const tx = refund();
    run(tx, wallet);

    const entry = run(tx, wallet, aProcessed({ kind: Kind.Bet }));

    expect(tx.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });
});

describe('a terminal transaction', () => {
  test('throws when processing an already PROCESSED transaction without mutating the wallet', () => {
    const wallet = aWallet('100.00');
    const tx = aTransaction({ money: brl('80.00') });

    run(tx, wallet);
    const balanceAfterFirst = wallet.balance.toJSON().amount;
    const versionAfterFirst = wallet.version;

    expect(() => run(tx, wallet)).toThrow(InvalidWagerTransactionError);
    expect(wallet.balance.toJSON().amount).toBe(balanceAfterFirst);
    expect(wallet.version).toBe(versionAfterFirst);
  });

  test('throws when processing an already REJECTED transaction without mutating the wallet', () => {
    const wallet = aWallet('20.00');
    const tx = aTransaction({ money: brl('80.00') });

    run(tx, wallet);
    expect(tx.status).toBe(Status.Rejected);

    const walletWithFunds = aWallet('100.00');
    expect(() => run(tx, walletWithFunds)).toThrow(InvalidWagerTransactionError);
    expect(walletWithFunds.balance.toJSON().amount).toBe('100.00');
    expect(walletWithFunds.version).toBe(1);
  });
});
