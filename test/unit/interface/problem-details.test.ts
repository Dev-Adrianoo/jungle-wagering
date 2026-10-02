import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  InvalidCursorError,
  StaleWalletVersionError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { InvalidMoneyError } from '../../../src/domain/money/money';
import { InvalidTransactionStateError } from '../../../src/domain/wagering/wager-transaction';
import { NegativeInitialBalanceError } from '../../../src/domain/wallet/wallet';
import { RequestValidationError } from '../../../src/interface/contracts/parse';
import { toProblem } from '../../../src/interface/http/problem-details.filter';

describe('toProblem', () => {
  test.each([
    [
      'invalid payload',
      new RequestValidationError([{ path: 'a', message: 'b' }]),
      400,
      'VALIDATION_ERROR',
    ],
    [
      'missing idempotency key',
      new RequestValidationError([], 'IDEMPOTENCY_KEY_MISSING'),
      400,
      'IDEMPOTENCY_KEY_MISSING',
    ],
    ['invalid cursor', new InvalidCursorError(), 400, 'VALIDATION_ERROR'],
    ['invalid money', new InvalidMoneyError('bad'), 400, 'INVALID_MONEY'],
    [
      'negative initial balance',
      new NegativeInitialBalanceError(),
      400,
      'NEGATIVE_INITIAL_BALANCE',
    ],
    ['unknown wallet', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    ['unknown transaction', new TransactionNotFoundError('t'), 404, 'TRANSACTION_NOT_FOUND'],
    ['duplicate wallet', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    ['idempotency conflict', new IdempotencyKeyConflictError('k'), 409, 'IDEMPOTENCY_KEY_CONFLICT'],
    [
      'duplicate external transaction',
      new DuplicateExternalTransactionError('p', 'e'),
      409,
      'DUPLICATE_EXTERNAL_TRANSACTION',
    ],
    ['transient failure', new TransientInfrastructureError('down'), 503, 'SERVICE_UNAVAILABLE'],
    ['stale version', new StaleWalletVersionError('w'), 503, 'SERVICE_UNAVAILABLE'],
    [
      'unresolved idempotency key violation',
      new UniqueViolationError('wager_tx_idempotency_key_unique'),
      503,
      'SERVICE_UNAVAILABLE',
    ],
    [
      'unresolved provider external id violation',
      new UniqueViolationError('wager_tx_provider_external_unique'),
      503,
      'SERVICE_UNAVAILABLE',
    ],
    ['any other unique violation', new UniqueViolationError('c'), 500, 'INTERNAL_ERROR'],
    ['malformed body', new BadRequestException('bad json'), 400, 'VALIDATION_ERROR'],
    ['unknown route', new NotFoundException(), 404, 'NOT_FOUND'],
  ])('%s → %i %s', (_name, exception, status, code) => {
    const problem = toProblem(exception);

    expect(problem.status).toBe(status);
    expect(problem.code).toBe(code);
  });

  test('validation problems list the offending paths', () => {
    const problem = toProblem(new RequestValidationError([{ path: 'money.amount', message: 'x' }]));
    expect(problem.errors).toEqual([{ path: 'money.amount', message: 'x' }]);
  });

  test.each([
    [413, 'PAYLOAD_TOO_LARGE', 'request entity too large', 'entity.too.large'],
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'unsupported charset', 'charset.unsupported'],
    [418, 'HTTP_ERROR', 'teapot', 'other'],
  ])(
    'a client error with status %i from the body parser becomes %s',
    (status, code, message, type) => {
      const problem = toProblem(
        Object.assign(new Error(message), { status, statusCode: status, type }),
      );

      expect(problem.status).toBe(status);
      expect(problem.code).toBe(code);
      expect(problem.detail).not.toContain(message);
    },
  );

  test.each([500, 302])('an error with status %i is still a generic 500', (status) => {
    expect(toProblem(Object.assign(new Error('x'), { status })).status).toBe(500);
  });

  test.each([
    ['a programming error in the domain', new InvalidTransactionStateError('terminal')],
    ['an unknown error', new Error('pg: connection string is postgres://user:secret@host')],
    ['a driver error with its own code', Object.assign(new Error('boom'), { code: '23503' })],
    ['a thrown non-error', 'boom'],
  ])('%s becomes a generic 500 that leaks nothing', (_name, exception) => {
    expect(toProblem(exception)).toEqual({
      type: 'urn:wagering:problem:internal-error',
      title: 'Internal error',
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'an unexpected error occurred',
    });
  });
});
