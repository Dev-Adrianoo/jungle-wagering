import { describe, expect, test } from 'bun:test';
import { eventsFor } from '../../../src/application/events/wager-event-factory';
import type { EventContext } from '../../../src/domain/events/integration-event';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
import { AT, aTransaction, aWallet } from '../../support/builders';

let counter = 0;
const newContext = (): EventContext => {
  counter += 1;
  return {
    eventId: `event-${counter}`,
    correlationId: 'corr-1',
    causationId: 'tx-1',
    occurredAt: AT,
  };
};

const typesOf = (events: Array<{ eventType: string }>) => events.map((event) => event.eventType);

describe('eventsFor', () => {
  test('a balance-changing PROCESSED transaction emits two events with distinct ids', () => {
    const wallet = aWallet('100.00');
    const tx = aTransaction();
    const entry = wallet.debit(tx.money, { transactionId: tx.id, entryId: 'entry-1', at: AT });
    tx.markProcessed(undefined, wallet.balance, AT);

    const events = eventsFor(tx, wallet, entry, newContext);

    expect(typesOf(events)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  test('a PROCESSED LOSS emits only WagerTransactionProcessed', () => {
    const wallet = aWallet('100.00');
    const tx = aTransaction({ kind: Kind.Loss });
    tx.markProcessed(undefined, wallet.balance, AT);

    expect(typesOf(eventsFor(tx, wallet, undefined, newContext))).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  test('a REJECTED transaction emits only WagerTransactionRejected', () => {
    const wallet = aWallet('10.00');
    const tx = aTransaction();
    tx.reject(FailureCode.InsufficientFunds, wallet.balance, AT);

    expect(typesOf(eventsFor(tx, wallet, undefined, newContext))).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  test('a PENDING_REFERENCE transaction emits only WagerTransactionPendingReference', () => {
    const wallet = aWallet('10.00');
    const tx = aTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(wallet.balance, AT);

    expect(typesOf(eventsFor(tx, wallet, undefined, newContext))).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });
});
