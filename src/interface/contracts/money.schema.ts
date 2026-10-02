import { z } from 'zod';

export const nonNegativeMoneySchema = z.object({
  amount: z
    .string()
    .regex(
      /^(0|[1-9]\d{0,17})(\.\d{1,2})?$/,
      'must be a non-negative decimal string with at most 2 decimal places',
    ),
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO-4217 code'),
});
