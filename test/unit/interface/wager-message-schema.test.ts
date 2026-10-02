import { describe, expect, test } from 'bun:test';
import { RequestValidationError } from '../../../src/interface/contracts/parse';
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

describe('parseWagerMessage', () => {
  test('parses the documented message', () => {
    const parsed = parseWagerMessage(envelope());
    const { idempotencyKey: _key, ...payload } = data;

    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.payload).toEqual(payload as never);
    expect(parsed.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('uses the envelope correlation id, or the message id when there is none', () => {
    expect(parseWagerMessage(envelope({ correlationId: 'trace-1' })).correlationId).toBe('trace-1');
    expect(parseWagerMessage(envelope()).correlationId).toBe('msg-123');
  });

  test('the hash covers the business payload and the idempotency key, not the envelope', () => {
    const base = parseWagerMessage(envelope()).payloadHash;

    expect(
      parseWagerMessage(envelope({ occurredAt: '2027-01-01T00:00:00.000Z' })).payloadHash,
    ).toBe(base);
    expect(
      parseWagerMessage(
        envelope({ data: { ...data, money: { amount: '26.00', currency: 'BRL' } } }),
      ).payloadHash,
    ).not.toBe(base);
    expect(
      parseWagerMessage(envelope({ data: { ...data, idempotencyKey: 'another-key' } })).payloadHash,
    ).not.toBe(base);
  });

  test.each([
    ['a body that is not JSON', '{"messageId": '],
    ['a JSON array', '[]'],
    ['a missing messageId', envelope({ messageId: undefined })],
    ['an unknown type', envelope({ type: 'SomethingElse' })],
    ['missing data', envelope({ data: undefined })],
    ['a missing idempotency key', envelope({ data: { ...data, idempotencyKey: undefined } })],
    ['kind OPENING', envelope({ data: { ...data, kind: 'OPENING' } })],
    [
      'an amount sent as a number',
      envelope({ data: { ...data, money: { amount: 25, currency: 'BRL' } } }),
    ],
    ['a wallet id that is not a UUID', envelope({ data: { ...data, walletId: 'wallet-1' } })],
  ])('rejects %s', (_name, body) => {
    expect(() => parseWagerMessage(body)).toThrow(RequestValidationError);
  });
});
