import { describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  canonicalWagerPayload,
  hashWagerPayload,
  sha256Hex,
  type WagerPayload,
} from '../../../src/application/idempotency/payload-hash';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test('drops undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('escapes strings like JSON does', () => {
    expect(canonicalJson({ a: 'he said "hi"\n' })).toBe('{"a":"he said \\"hi\\"\\n"}');
  });
});

describe('canonicalWagerPayload', () => {
  test('produces the documented canonical form', () => {
    expect(canonicalWagerPayload(payload)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},' +
        '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a",' +
        '"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
  });

  test('includes the reference when present', () => {
    expect(
      canonicalWagerPayload({
        ...payload,
        kind: 'REFUND',
        referenceExternalTransactionId: 'ext-bet',
      }),
    ).toContain('"providerId":"provider-a","referenceExternalTransactionId":"ext-bet","roundId"');
  });
});

describe('hashWagerPayload', () => {
  test('is the SHA-256 of the canonical form, in hex', () => {
    const hash = hashWagerPayload(payload);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256Hex(canonicalWagerPayload(payload)));
  });

  test('does not depend on key order', () => {
    const reordered = Object.fromEntries(
      Object.entries(payload).reverse(),
    ) as unknown as WagerPayload;
    expect(hashWagerPayload(reordered)).toBe(hashWagerPayload(payload));
  });

  test('treats 25, 25.0 and 25.00 as the same amount', () => {
    const withAmount = (amount: string) =>
      hashWagerPayload({ ...payload, money: { amount, currency: 'BRL' } });

    expect(withAmount('25')).toBe(withAmount('25.00'));
    expect(withAmount('25.0')).toBe(withAmount('25.00'));
  });

  test('ignores fields that are not part of the business payload', () => {
    const noisy = { ...payload, idempotencyKey: 'k', receivedAt: 'now' } as WagerPayload;
    expect(hashWagerPayload(noisy)).toBe(hashWagerPayload(payload));
  });

  test('an absent reference and an undefined reference hash the same', () => {
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      hashWagerPayload(payload),
    );
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' as const }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'ext-bet' }],
  ])('changes when %s changes', (_field, change) => {
    expect(hashWagerPayload({ ...payload, ...change })).not.toBe(hashWagerPayload(payload));
  });
});
