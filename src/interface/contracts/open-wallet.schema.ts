import { z } from 'zod';
import { nonNegativeMoneySchema } from './money.schema';
import { uuidSchema } from './uuid.schema';

export const openWalletSchema = z.object({
  playerId: uuidSchema,
  initialBalance: nonNegativeMoneySchema,
});

export const walletParamsSchema = z.object({
  walletId: uuidSchema,
});

export const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
