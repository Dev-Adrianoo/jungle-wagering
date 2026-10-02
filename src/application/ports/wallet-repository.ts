import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
