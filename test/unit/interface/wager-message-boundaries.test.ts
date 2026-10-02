import { describe, expect, test } from 'bun:test';
import { parseWagerMessage } from '../../../src/interface/contracts/wager-message.schema';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data,
    ...overrides,
  });
const accepts = (overrides: Record<string, unknown>) => {
  try {
    parseWagerMessage(envelope(overrides));
    return true;
  } catch {
    return false;
  }
};

describe('parseWagerMessage envelope boundaries', () => {
  test('messageId accepts 200 characters and rejects 0 and 201', () => {
    expect(accepts({ messageId: 'x'.repeat(200) })).toBe(true);
    expect(accepts({ messageId: '' })).toBe(false);
    expect(accepts({ messageId: 'x'.repeat(201) })).toBe(false);
  });

  test('occurredAt is required and bounded to 64 characters', () => {
    expect(accepts({ occurredAt: 'x'.repeat(64) })).toBe(true);
    expect(accepts({ occurredAt: undefined })).toBe(false);
    expect(accepts({ occurredAt: '' })).toBe(false);
    expect(accepts({ occurredAt: 'x'.repeat(65) })).toBe(false);
  });

  test('correlationId accepts the safe alphabet up to 128 characters', () => {
    expect(accepts({ correlationId: 'a.b_c:d-E9' })).toBe(true);
    expect(accepts({ correlationId: 'x'.repeat(128) })).toBe(true);
    expect(accepts({ correlationId: 'x'.repeat(129) })).toBe(false);
  });

  test.each(['', 'bad id', 'ok bad', 'bad ok', '<tag>', 'a/b'])(
    'correlationId rejects %p',
    (correlationId) => {
      expect(accepts({ correlationId })).toBe(false);
    },
  );

  test('the hash does not depend on how the amount is written', () => {
    const base = parseWagerMessage(envelope()).payloadHash;
    const short = parseWagerMessage(
      envelope({ data: { ...data, money: { amount: '25', currency: 'BRL' } } }),
    ).payloadHash;

    expect(short).toBe(base);
  });
});
