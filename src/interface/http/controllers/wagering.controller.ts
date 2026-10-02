import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { SubmitWagerResult, TransactionView } from '../../../application/views';
import type { Core } from '../../../composition/core';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction';
import { parseWith } from '../../contracts/parse';
import { parseIdempotencyKey, wagerPayloadSchema } from '../../contracts/wager-payload.schema';
import { Roles } from '../auth/decorators';
import { CorrelationId } from '../correlation';
import { CORE } from '../tokens';

const transactionParamsSchema = z.object({ transactionId: z.uuid() });

const providerTransactionParamsSchema = z.object({
  providerId: z.string().min(1).max(100),
  externalTransactionId: z.string().min(1).max(200),
});

// 201 applied now, 200 replay of an applied transaction, 202 accepted but waiting for its
// reference, 422 refused by a business rule (also on replay). The provider can tell these
// apart by status alone.
export function httpStatusFor(result: SubmitWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    default:
      return 422;
  }
}

@Controller()
export class WageringController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post('wagering/transactions')
  @Roles('provider')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerResult> {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const payload = parseWith(wagerPayloadSchema, body);
    const result = await this.core.submitWager.execute({ idempotencyKey, payload, correlationId });
    response.status(httpStatusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  @Roles('operator', 'auditor')
  getById(@Param() params: unknown): Promise<TransactionView> {
    const { transactionId } = parseWith(transactionParamsSchema, params);
    return this.core.transactionQueries.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @Roles('provider', 'operator', 'auditor')
  getByProvider(@Param() params: unknown): Promise<TransactionView> {
    const { providerId, externalTransactionId } = parseWith(
      providerTransactionParamsSchema,
      params,
    );
    return this.core.transactionQueries.getByProvider(providerId, externalTransactionId);
  }
}
