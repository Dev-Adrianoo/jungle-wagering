import { describe, expect, test } from 'bun:test';
import type { SubmitWagerResult } from '../../../src/application/views';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction';
import { httpStatusFor } from '../../../src/interface/http/controllers/wagering.controller';

const result = (status: Status, idempotentReplay = false): SubmitWagerResult => ({
  transactionId: 'tx-1',
  status,
  balance: { amount: '1.00', currency: 'BRL' },
  idempotentReplay,
});

describe('httpStatusFor', () => {
  test.each([
    ['applied now', result(Status.Processed), 201],
    ['replay of an applied transaction', result(Status.Processed, true), 200],
    ['waiting for a reference', result(Status.PendingReference), 202],
    ['replay while waiting', result(Status.PendingReference, true), 202],
    ['business rejection', result(Status.Rejected), 422],
    ['replay of a rejection', result(Status.Rejected, true), 422],
    ['permanent infrastructure failure', result(Status.Failed), 500],
  ])('%s → %i', (_name, submitted, status) => {
    expect(httpStatusFor(submitted)).toBe(status);
  });

  test('a status the API never returns is a programming error', () => {
    expect(() => httpStatusFor(result(Status.Pending))).toThrow();
  });
});
