import { randomUUID } from 'node:crypto';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wagering/wager-transaction';
import { type OpenedWallet, Wallet } from '../../src/domain/wallet/wallet';
import { brl } from './builders';

export function newWallet(balance: string): OpenedWallet {
  return Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: brl(balance),
    openingTransactionId: randomUUID(),
    openingEntryId: randomUUID(),
    at: new Date(),
  });
}

export function newTransaction(
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const id = randomUUID();
  return WagerTransaction.create({
    id,
    providerId: 'provider-a',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `provider-a:ext-${id}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    referenceExternalTransactionId: undefined,
    correlationId: 'corr-test',
    createdAt: new Date(),
    ...overrides,
  });
}
