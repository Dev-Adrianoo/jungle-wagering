import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { AT } from '../../support/builders';

const LATER = new Date('2026-10-01T12:00:01.000Z');
const received = () =>
  InboxMessage.receive({
    messageId: 'msg-1',
    consumerName: 'wager-transaction-consumer',
    payloadHash: 'a'.repeat(64),
    receivedAt: AT,
  });

describe('InboxMessage', () => {
  test('is received unprocessed', () => {
    const message = received();

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed records when it was handled', () => {
    const message = received();

    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(LATER);
  });

  test('toState round-trips through rehydrate', () => {
    const message = received();
    message.markProcessed(LATER);

    expect(InboxMessage.rehydrate(message.toState()).toState()).toEqual(message.toState());
  });
});
