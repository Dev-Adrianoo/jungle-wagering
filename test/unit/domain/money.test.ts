import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.50', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['-10.01', '-10.01'],
    ['-0', '0.00'],
    ['-0.00', '0.00'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '10.001',
    '.5',
    '5.',
    '01.00',
    '+1.00',
    '1,00',
    '1 000',
    '0x10',
    'abc',
    '1000000000000000000.00',
  ])('rejects amount %p', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test('rejects a non-string amount', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L'])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('never rounds: a third decimal place is an error, not a rounding', () => {
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
    expect(() => brl('0.999')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  test('adds exactly where binary floats would not', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('subtracts and may go negative', () => {
    expect(brl('10.00').subtract(brl('25.50')).toJSON().amount).toBe('-15.50');
  });

  test('keeps every digit of the largest supported value', () => {
    const max = brl('999999999999999999.99');
    expect(max.subtract(brl('0.01')).toJSON().amount).toBe('999999999999999999.98');
  });

  test('negates, and negating zero stays 0.00', () => {
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(brl('0').negate().toJSON().amount).toBe('0.00');
  });

  test('is immutable: operations return new instances', () => {
    const original = brl('10.00');
    const sum = original.add(brl('1.00'));

    expect(sum).not.toBe(original);
    expect(original.toJSON().amount).toBe('10.00');
  });

  test('zero() builds 0.00 in the given currency', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });
});

describe('Money comparisons', () => {
  test('sign checks', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0').isPositive()).toBe(false);
    expect(brl('0').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
  });

  test('isLessThan', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
  });

  test('equals compares value and currency', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money currency conflicts', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('add, subtract and isLessThan refuse a different currency', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money serialization', () => {
  test('toString shows the fixed scale and the currency', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });

  test('JSON.stringify uses toJSON', () => {
    expect(JSON.stringify({ money: brl('7.5') })).toBe(
      '{"money":{"amount":"7.50","currency":"BRL"}}',
    );
  });
});
