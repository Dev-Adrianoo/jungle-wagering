import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { LedgerPageView, ReconciliationView, WalletView } from '../../../application/views';
import type { Core } from '../../../composition/core';
import {
  ledgerQuerySchema,
  openWalletSchema,
  walletParamsSchema,
} from '../../contracts/open-wallet.schema';
import { parseWith } from '../../contracts/parse';
import { CorrelationId } from '../correlation';
import { CORE } from '../tokens';

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post()
  open(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<WalletView> {
    const input = parseWith(openWalletSchema, body);
    return this.core.openWallet.execute({ ...input, correlationId });
  }

  @Get(':walletId')
  get(@Param() params: unknown): Promise<WalletView> {
    const { walletId } = parseWith(walletParamsSchema, params);
    return this.core.walletQueries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(@Param() params: unknown, @Query() query: unknown): Promise<LedgerPageView> {
    const { walletId } = parseWith(walletParamsSchema, params);
    const { limit, cursor } = parseWith(ledgerQuerySchema, query);
    return this.core.walletQueries.getLedger(walletId, { cursor, limit });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param() params: unknown): Promise<ReconciliationView> {
    const { walletId } = parseWith(walletParamsSchema, params);
    return this.core.reconcileWallet.execute(walletId);
  }
}
