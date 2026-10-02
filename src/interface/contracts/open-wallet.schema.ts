import { z } from 'zod';
import { nonNegativeMoneySchema } from './money.schema';

export const openWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: nonNegativeMoneySchema,
});

export const walletParamsSchema = z.object({
  walletId: z.uuid(),
});

export const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
