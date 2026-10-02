import { describe, expect, test } from 'bun:test';
import {
  ledgerQuerySchema,
  openWalletSchema,
} from '../../../src/interface/contracts/open-wallet.schema';
import { parseWith, RequestValidationError } from '../../../src/interface/contracts/parse';
import { wagerPayloadSchema } from '../../../src/interface/contracts/wager-payload.schema';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const accepts = (input: unknown) => wagerPayloadSchema.safeParse(input).success;
const withMoney = (amount: string, currency = 'BRL') => ({ ...valid, money: { amount, currency } });

describe('wagerPayloadSchema boundaries', () => {
  test.each(['BET', 'WIN', 'LOSS'])('accepts kind %s', (kind) => {
    expect(accepts({ ...valid, kind })).toBe(true);
  });

  test.each(['REFUND', 'ROLLBACK'])('accepts kind %s with a reference', (kind) => {
    expect(accepts({ ...valid, kind, referenceExternalTransactionId: 'transaction-1' })).toBe(true);
  });

  test.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'])('rejects a zero %s', (kind) => {
    const input = { ...withMoney('0.00'), kind, referenceExternalTransactionId: 'transaction-1' };
    expect(accepts(input)).toBe(false);
  });

  test.each(['0', '0.0', '0.00'])('rejects a zero BET written as %s', (amount) => {
    expect(accepts(withMoney(amount))).toBe(false);
  });

  test.each(['0.5', '0.05', '10', '10.5', '999999999999999999.99'])(
    'accepts the amount %s',
    (amount) => {
      expect(accepts(withMoney(amount))).toBe(true);
    },
  );

  test.each(['007.00', '00', '5.', '.5', '1.234', '1e3', ' 5', '5 ', '9999999999999999999.00'])(
    'rejects the amount %p',
    (amount) => {
      expect(accepts(withMoney(amount))).toBe(false);
    },
  );

  test.each(['BR', 'BRLL', 'brl', 'xBRL', 'BRLx', 'BR1', ''])('rejects the currency %p', (code) => {
    expect(accepts(withMoney('5.00', code))).toBe(false);
  });

  test.each([
    ['providerId', 100],
    ['externalTransactionId', 200],
    ['roundId', 200],
    ['gameId', 200],
  ])('%s accepts %i characters and rejects one more', (field, max) => {
    expect(accepts({ ...valid, [field]: 'x'.repeat(max) })).toBe(true);
    expect(accepts({ ...valid, [field]: 'x'.repeat(max + 1) })).toBe(false);
  });

  test('the reference accepts 200 characters and rejects 201', () => {
    const base = { ...valid, kind: 'REFUND' };
    expect(accepts({ ...base, referenceExternalTransactionId: 'x'.repeat(200) })).toBe(true);
    expect(accepts({ ...base, referenceExternalTransactionId: 'x'.repeat(201) })).toBe(false);
  });

  test('ids are normalised to lower case', () => {
    const parsed = parseWith(wagerPayloadSchema, {
      ...valid,
      playerId: valid.playerId.toUpperCase(),
      walletId: valid.walletId.toUpperCase(),
    });

    expect(parsed.playerId).toBe(valid.playerId);
    expect(parsed.walletId).toBe(valid.walletId);
  });

  test('a validation failure never carries the received value', () => {
    try {
      parseWith(wagerPayloadSchema, withMoney('secret-amount'));
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect(JSON.stringify((error as RequestValidationError).issues)).not.toContain('secret');
      return;
    }
    throw new Error('expected a validation error');
  });
});

describe('request contracts', () => {
  test('the ledger page defaults to 50 entries', () => {
    expect(ledgerQuerySchema.parse({}).limit).toBe(50);
  });

  test('the ledger limit comes from the query string as text', () => {
    expect(ledgerQuerySchema.parse({ limit: '7' }).limit).toBe(7);
  });

  test.each(['0', '101', '1.5', 'abc'])('rejects the ledger limit %p', (limit) => {
    expect(ledgerQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  test('the cursor accepts 200 characters and rejects 0 and 201', () => {
    expect(ledgerQuerySchema.safeParse({ cursor: 'x'.repeat(200) }).success).toBe(true);
    expect(ledgerQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(ledgerQuerySchema.safeParse({ cursor: 'x'.repeat(201) }).success).toBe(false);
  });

  test('a wallet is opened for a UUID player, normalised to lower case', () => {
    const parsed = openWalletSchema.parse({
      playerId: valid.playerId.toUpperCase(),
      initialBalance: { amount: '0', currency: 'BRL' },
    });

    expect(parsed.playerId).toBe(valid.playerId);
    expect(
      openWalletSchema.safeParse({ playerId: 'p1', initialBalance: valid.money }).success,
    ).toBe(false);
  });
});
