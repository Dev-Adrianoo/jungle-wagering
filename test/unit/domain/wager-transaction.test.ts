import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransactionKind as Kind,
  REFERENCE_RETRY_POLICY,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { AT, aProcessed, aTransaction, brl } from '../../support/builders';

const LATER = new Date('2026-10-01T12:00:10.000Z');
const secondsAfter = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

describe('WagerTransaction.create', () => {
  test('is born PENDING with no outcome yet', () => {
    const tx = aTransaction();

    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceAttempts).toBe(0);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => aTransaction({ kind, referenceExternalTransactionId: undefined })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => aTransaction({ kind, referenceExternalTransactionId: 'ext-bet' })).not.toThrow();
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback, Kind.Opening])(
    '%s must be greater than zero',
    (kind) => {
      expect(() =>
        aTransaction({ kind, money: brl('0'), referenceExternalTransactionId: 'ext-bet' }),
      ).toThrow(InvalidWagerTransactionError);
    },
  );

  test('LOSS may carry zero', () => {
    expect(() => aTransaction({ kind: Kind.Loss, money: brl('0') })).not.toThrow();
  });

  test('refuses a negative amount for every kind', () => {
    expect(() => aTransaction({ kind: Kind.Loss, money: brl('-1.00') })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('requires round and game except for OPENING', () => {
    expect(() => aTransaction({ roundId: undefined })).toThrow(InvalidWagerTransactionError);
    expect(() => aTransaction({ gameId: undefined })).toThrow(InvalidWagerTransactionError);
    expect(() =>
      aTransaction({ kind: Kind.Opening, roundId: undefined, gameId: undefined }),
    ).not.toThrow();
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING → PROCESSED records reference, balance and time', () => {
    const tx = aTransaction();

    tx.markProcessed('ref-id', brl('75.00'), LATER);

    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.observedBalance.toJSON().amount).toBe('75.00');
    expect(tx.processedAt).toEqual(LATER);
    expect(tx.updatedAt).toEqual(LATER);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED keeps the failure code and has no processedAt', () => {
    const tx = aTransaction();

    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), LATER);

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance.toJSON().amount).toBe('20.00');
    expect(tx.processedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → FAILED is terminal and auditable', () => {
    const tx = aTransaction();

    tx.fail(FailureCode.InternalError, brl('20.00'), LATER);

    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalError);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE schedules the first retry after the base delay', () => {
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });

    tx.markPendingReference(brl('100.00'), AT);

    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextAttemptAt).toEqual(secondsAfter(AT, 5));
  });

  test('PENDING_REFERENCE → PROCESSED clears the retry schedule', () => {
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(brl('100.00'), AT);

    tx.markProcessed('ref-id', brl('125.00'), LATER);

    expect(tx.status).toBe(Status.Processed);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test.each([
    [
      'PROCESSED',
      (tx: ReturnType<typeof aTransaction>) => tx.markProcessed(undefined, brl('1.00'), LATER),
    ],
    [
      'REJECTED',
      (tx: ReturnType<typeof aTransaction>) =>
        tx.reject(FailureCode.InsufficientFunds, brl('1.00'), LATER),
    ],
    [
      'FAILED',
      (tx: ReturnType<typeof aTransaction>) =>
        tx.fail(FailureCode.InternalError, brl('1.00'), LATER),
    ],
  ])('%s is terminal: every further transition is a programming error', (_name, finish) => {
    const tx = aTransaction();
    finish(tx);

    expect(() => tx.markProcessed(undefined, brl('1.00'), LATER)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), LATER)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.InternalError, brl('1.00'), LATER)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference(brl('1.00'), LATER)).toThrow(InvalidTransactionStateError);
    expect(() => tx.registerReferenceMiss(brl('1.00'), LATER)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('markPendingReference is only valid from PENDING', () => {
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(brl('100.00'), AT);

    expect(() => tx.markPendingReference(brl('100.00'), LATER)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('registerReferenceMiss is only valid from PENDING_REFERENCE', () => {
    expect(() => aTransaction().registerReferenceMiss(brl('1.00'), LATER)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('observedBalance is not readable before a decision exists', () => {
    expect(() => aTransaction().observedBalance).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction reference retries', () => {
  test('backs off 10s, 20s, 40s, 80s, 160s then caps at 300s', () => {
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(brl('100.00'), AT);

    const delays: number[] = [];
    for (let miss = 1; miss < REFERENCE_RETRY_POLICY.maxAttempts; miss += 1) {
      tx.registerReferenceMiss(brl('100.00'), AT);
      delays.push(((tx.nextAttemptAt as Date).getTime() - AT.getTime()) / 1000);
    }

    expect(delays).toEqual([10, 20, 40, 80, 160, 300, 300, 300, 300]);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(9);
  });

  test('the tenth miss rejects with REFERENCE_NOT_FOUND', () => {
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(brl('100.00'), AT);

    for (let miss = 1; miss <= REFERENCE_RETRY_POLICY.maxAttempts; miss += 1) {
      tx.registerReferenceMiss(brl('100.00'), LATER);
    }

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.referenceAttempts).toBe(10);
    expect(tx.nextAttemptAt).toBeUndefined();
  });
});

describe('WagerTransaction queries', () => {
  test('affectsBalance is false only for LOSS', () => {
    expect(aTransaction({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(aTransaction({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(aTransaction({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  test('requiresReference is true only for REFUND and ROLLBACK', () => {
    expect(aTransaction({ kind: Kind.Bet }).requiresReference()).toBe(false);
    expect(aTransaction({ kind: Kind.Win }).requiresReference()).toBe(false);
    expect(
      aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'x' }).requiresReference(),
    ).toBe(true);
    expect(
      aTransaction({
        kind: Kind.Rollback,
        referenceExternalTransactionId: 'x',
      }).requiresReference(),
    ).toBe(true);
  });

  test('matchesPayload compares hashes', () => {
    const tx = aTransaction({ payloadHash: 'a'.repeat(64) });
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('ledgerDirectionFor: BET debits; WIN, REFUND and OPENING credit', () => {
    expect(aTransaction({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(aTransaction({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'x' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(
      aTransaction({
        kind: Kind.Opening,
        roundId: undefined,
        gameId: undefined,
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: ROLLBACK is the inverse of its reference', () => {
    const rollback = aTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });

    expect(rollback.ledgerDirectionFor(aProcessed({ kind: Kind.Bet }))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(aProcessed({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(
      rollback.ledgerDirectionFor(
        aProcessed({ kind: Kind.Refund, referenceExternalTransactionId: 'y' }),
      ),
    ).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('ledgerDirectionFor: LOSS has no direction', () => {
    expect(() => aTransaction({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('rebuilds a terminal transaction without replaying transitions', () => {
    const tx = aProcessed({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds });

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.toState().failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('toState round-trips through rehydrate', () => {
    const original = aProcessed();
    expect(aProcessed(original.toState()).toState()).toEqual(original.toState());
  });
});
