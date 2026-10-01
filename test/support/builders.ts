import { Money } from '../../src/domain/money/money';
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
