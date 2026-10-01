import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../../src/domain/shared/domain-error';

class SampleError extends DomainError {
  readonly code = 'SAMPLE';
}

describe('DomainError', () => {
  test('carries a machine-readable code and the subclass name', () => {
    const error = new SampleError('something broke');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('SAMPLE');
    expect(error.name).toBe('SampleError');
    expect(error.message).toBe('something broke');
  });
});
