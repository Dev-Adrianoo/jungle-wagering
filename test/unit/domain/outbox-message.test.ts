import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { AT, aWallet, brl, WALLET_ID } from '../../support/builders';

const secondsAfter = (seconds: number) => new Date(AT.getTime() + seconds * 1000);

function anEvent() {
  const wallet = aWallet('100.00');
  const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'entry-1', at: AT });
  return WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    causationId: 'tx-1',
    occurredAt: AT,
  });
}

describe('OutboxMessage.enqueue', () => {
  test('stores the serialized envelope and is due immediately', () => {
    const event = anEvent();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe(WALLET_ID);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(AT)).toBe(true);
  });
});

describe('OutboxMessage retries', () => {
  test('backs off 1s, 2s, 4s and caps at 60s', () => {
    const message = OutboxMessage.enqueue(anEvent());

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      message.scheduleRetry(AT);
      delays.push(((message.nextAttemptAt as Date).getTime() - AT.getTime()) / 1000);
    }

    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(message.attempts).toBe(8);
  });

  test('is not due before nextAttemptAt', () => {
    const message = OutboxMessage.enqueue(anEvent());
    message.scheduleRetry(AT);

    expect(message.isDue(AT)).toBe(false);
    expect(message.isDue(secondsAfter(1))).toBe(true);
  });
});

describe('OutboxMessage.markPublished', () => {
  test('stops being pending or due', () => {
    const message = OutboxMessage.enqueue(anEvent());

    message.markPublished(secondsAfter(2));

    expect(message.publishedAt).toEqual(secondsAfter(2));
    expect(message.isPending()).toBe(false);
    expect(message.isDue(secondsAfter(3600))).toBe(false);
  });

  test('toState round-trips through rehydrate', () => {
    const message = OutboxMessage.enqueue(anEvent());
    expect(OutboxMessage.rehydrate(message.toState()).toState()).toEqual(message.toState());
  });
});
