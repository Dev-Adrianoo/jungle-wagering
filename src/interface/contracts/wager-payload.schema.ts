// The contract of a wager request. HTTP validates the body with it and, in plan 2, the SQS
// consumer validates message data with the same schema, so both entry points accept and
// reject exactly the same payloads.
import { z } from 'zod';
import { INTERNAL_PROVIDER_ID } from '../../domain/wagering/wager-transaction';
import { nonNegativeMoneySchema } from './money.schema';
import { parseWith } from './parse';

const text = (max: number) => z.string().min(1).max(max);
const ZERO = /^0(\.0{1,2})?$/;

export const wagerPayloadSchema = z
  .object({
    providerId: text(100).refine((value) => value !== INTERNAL_PROVIDER_ID, {
      message: 'is reserved for internal transactions',
    }),
    externalTransactionId: text(200),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: text(200),
    gameId: text(200),
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: nonNegativeMoneySchema,
    referenceExternalTransactionId: text(200).optional(),
  })
  .superRefine((payload, context) => {
    const isReversal = payload.kind === 'REFUND' || payload.kind === 'ROLLBACK';
    if (isReversal && payload.referenceExternalTransactionId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'is required for REFUND and ROLLBACK',
      });
    }
    if (payload.referenceExternalTransactionId === payload.externalTransactionId) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'cannot reference the transaction itself',
      });
    }
    if (payload.kind !== 'LOSS' && ZERO.test(payload.money.amount)) {
      context.addIssue({
        code: 'custom',
        path: ['money', 'amount'],
        message: 'must be greater than zero',
      });
    }
  });

export const idempotencyKeySchema = z.string().trim().min(1).max(255);

export function parseIdempotencyKey(header: unknown): string {
  return parseWith(
    z.object({ 'Idempotency-Key': idempotencyKeySchema }),
    { 'Idempotency-Key': header },
    'IDEMPOTENCY_KEY_MISSING',
  )['Idempotency-Key'];
}
