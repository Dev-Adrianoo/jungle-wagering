import { Money } from '../../src/domain/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet/wallet';

export const AT = new Date('2026-10-01T12:00:00.000Z');

export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

export function aWallet(balance: string, overrides: Partial<WalletState> = {}): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    balance: brl(balance),
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function aTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-1',
    createdAt: AT,
    ...overrides,
  });
}

export function aProcessed(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: 'tx-ref',
    providerId: 'provider-a',
    externalTransactionId: 'ext-ref',
    idempotencyKey: 'provider-a:ext-ref',
    payloadHash: 'b'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-ref',
    createdAt: AT,
    status: WagerTransactionStatus.Processed,
    referenceTransactionId: undefined,
    failureCode: undefined,
    observedBalance: brl('75.00'),
    referenceAttempts: 0,
    nextAttemptAt: undefined,
    updatedAt: AT,
    processedAt: AT,
    ...overrides,
  });
}
