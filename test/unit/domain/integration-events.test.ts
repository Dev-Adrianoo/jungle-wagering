import { describe, expect, test } from 'bun:test';
import type { EventContext } from '../../../src/domain/events/integration-event';
import { WagerTransactionFailed } from '../../../src/domain/events/wager-transaction-failed';
import { WagerTransactionPendingReference } from '../../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  InvalidTransactionStateError,
  WagerTransactionKind as Kind,
} from '../../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { AT, aTransaction, aWallet, brl, WALLET_ID } from '../../support/builders';

const context: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'tx-1',
  occurredAt: AT,
};

describe('WalletBalanceChanged', () => {
  test('serializes the envelope and the money as decimal strings', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'entry-1', at: AT });

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: WALLET_ID,
      correlationId: 'corr-1',
      causationId: 'tx-1',
      occurredAt: '2026-10-01T12:00:00.000Z',
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('omits causationId when there is none', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.credit(brl('1.00'), { transactionId: 'tx-1', entryId: 'entry-1', at: AT });

    const json = WalletBalanceChanged.from(wallet, entry, {
      ...context,
      causationId: undefined,
    }).toJSON();

    expect('causationId' in json).toBe(false);
  });

  test('survives a JSON round trip unchanged', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'entry-1', at: AT });
    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });
});

describe('WagerTransactionProcessed', () => {
  test('describes the applied transaction', () => {
    const tx = aTransaction();
    tx.markProcessed(undefined, brl('75.00'), AT);

    const json = WagerTransactionProcessed.from(tx, context).toJSON();

    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(WALLET_ID);
    expect(json.data).toEqual({
      transactionId: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      walletId: WALLET_ID,
      playerId: tx.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: Kind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      processedAt: '2026-10-01T12:00:00.000Z',
    });
  });
});

describe('WagerTransactionRejected', () => {
  test('carries the failure code', () => {
    const tx = aTransaction();
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), AT);

    const json = WagerTransactionRejected.from(tx, context).toJSON();

    expect(json.eventType).toBe('WagerTransactionRejected');
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.balance).toEqual({ amount: '20.00', currency: 'BRL' });
  });
});

describe('WagerTransactionPendingReference', () => {
  test('names the missing reference and the next attempt', () => {
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(brl('100.00'), AT);

    const json = WagerTransactionPendingReference.from(tx, context).toJSON();

    expect(json.eventType).toBe('WagerTransactionPendingReference');
    expect(json.data.referenceExternalTransactionId).toBe('ext-bet');
    expect(json.data.nextAttemptAt).toBe('2026-10-01T12:00:05.000Z');
  });
});

describe('WagerTransactionFailed', () => {
  test('carries the failure code and the wallet as aggregate', () => {
    const tx = aTransaction();
    tx.fail(FailureCode.InternalError, brl('20.00'), AT);

    const json = WagerTransactionFailed.from(tx, context).toJSON();

    expect(json.eventType).toBe('WagerTransactionFailed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(WALLET_ID);
    expect(json.data.failureCode).toBe(FailureCode.InternalError);
    expect(json.data.transactionId).toBe('tx-1');
  });

  test('refuses a transaction that did not fail', () => {
    expect(() => WagerTransactionFailed.from(aTransaction(), context)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionProcessed guards', () => {
  test('refuses a transaction that is not PROCESSED', () => {
    const tx = aTransaction();
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), AT);

    expect(() => WagerTransactionProcessed.from(tx, context)).toThrow(InvalidTransactionStateError);
  });
});
