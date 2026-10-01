// Arithmetic runs at 60 significant digits. decimal.js defaults to 20, which is exactly
// the size of the largest supported value, so a sum could be rounded.
import Decimal from 'decimal.js';
import { DomainError } from '../shared/domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

const AMOUNT_PATTERN = /^-?(0|[1-9]\d{0,17})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;

const Exact = Decimal.clone({ precision: 60 });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError('amount must be a decimal string with at most 2 decimal places');
    }
    if (typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter ISO-4217 code');
    }
    return Money.of(new Exact(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0', currency });
  }

  private static of(value: Decimal, currency: string): Money {
    return new Money(value.isZero() ? new Exact(0) : value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
