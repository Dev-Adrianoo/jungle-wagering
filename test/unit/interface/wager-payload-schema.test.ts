import { describe, expect, test } from 'bun:test';
import { parseWith, RequestValidationError } from '../../../src/interface/contracts/parse';
import {
  parseIdempotencyKey,
  wagerPayloadSchema,
} from '../../../src/interface/contracts/wager-payload.schema';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET' as const,
  money: { amount: '25.00', currency: 'BRL' },
};

function pathsOf(input: unknown): string[] {
  try {
    parseWith(wagerPayloadSchema, input);
    return [];
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return error.issues.map((issue) => issue.path);
    }
    throw error;
  }
}

describe('wagerPayloadSchema', () => {
  test('accepts the documented payload', () => {
    expect(parseWith(wagerPayloadSchema, valid)).toEqual(valid);
  });

  test('drops fields that are not part of the contract', () => {
    const parsed = parseWith(wagerPayloadSchema, { ...valid, idempotencyKey: 'k', extra: 1 });
    expect(parsed).toEqual(valid);
  });

  test.each([
    ['OPENING is internal', { kind: 'OPENING' }, 'kind'],
    ['an unknown kind', { kind: 'DEPOSIT' }, 'kind'],
    ['the reserved provider id', { providerId: 'internal' }, 'providerId'],
    ['an empty provider id', { providerId: '' }, 'providerId'],
    ['a wallet id that is not a UUID', { walletId: 'wallet-1' }, 'walletId'],
    ['a player id that is not a UUID', { playerId: 'player-1' }, 'playerId'],
    ['an amount sent as a number', { money: { amount: 25, currency: 'BRL' } }, 'money.amount'],
    ['three decimals', { money: { amount: '25.001', currency: 'BRL' } }, 'money.amount'],
    ['a negative amount', { money: { amount: '-25.00', currency: 'BRL' } }, 'money.amount'],
    ['a zero BET', { money: { amount: '0.00', currency: 'BRL' } }, 'money.amount'],
    ['a REFUND without reference', { kind: 'REFUND' }, 'referenceExternalTransactionId'],
    ['a ROLLBACK without reference', { kind: 'ROLLBACK' }, 'referenceExternalTransactionId'],
    [
      'a transaction that references itself',
      { kind: 'REFUND', referenceExternalTransactionId: 'transaction-123' },
      'referenceExternalTransactionId',
    ],
    ['a missing round', { roundId: undefined }, 'roundId'],
  ])('rejects %s', (_name, overrides, path) => {
    expect(pathsOf({ ...valid, ...overrides })).toContain(path);
  });

  test('accepts a zero LOSS', () => {
    expect(pathsOf({ ...valid, kind: 'LOSS', money: { amount: '0', currency: 'BRL' } })).toEqual(
      [],
    );
  });

  test('rejects a body that is not an object', () => {
    expect(pathsOf('BET')).not.toEqual([]);
    expect(pathsOf(null)).not.toEqual([]);
  });
});

describe('parseIdempotencyKey', () => {
  test('returns the trimmed key', () => {
    expect(parseIdempotencyKey('  provider-a:transaction-123 ')).toBe('provider-a:transaction-123');
  });

  test.each([undefined, '', '   ', 'x'.repeat(256), 42])('rejects %p', (header) => {
    expect(() => parseIdempotencyKey(header)).toThrow(RequestValidationError);
    try {
      parseIdempotencyKey(header);
    } catch (error) {
      expect((error as RequestValidationError).code).toBe('IDEMPOTENCY_KEY_MISSING');
    }
  });
});
