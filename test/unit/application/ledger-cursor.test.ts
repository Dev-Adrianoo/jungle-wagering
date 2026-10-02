import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../../src/application/errors';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../src/application/queries/ledger-cursor';

describe('ledger cursor', () => {
  test('round-trips a sequence number', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor('42'))).toBe('42');
  });

  test('is opaque and URL-safe', () => {
    const cursor = encodeLedgerCursor('9007199254740993');

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('9007199254740993');
    expect(decodeLedgerCursor(cursor)).toBe('9007199254740993');
  });

  test.each([
    '',
    '@@@',
    'not-base64url!!',
    Buffer.from('not json').toString('base64url'),
    Buffer.from('{"s":42}').toString('base64url'),
    Buffer.from('{"s":"-1"}').toString('base64url'),
    Buffer.from('{"s":"1; drop table wallets"}').toString('base64url'),
    Buffer.from('{"x":"1"}').toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ])('rejects %p', (cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCursorError);
  });
});
