import { LockMode } from '@mikro-orm/core';
import { StaleWalletVersionError } from '../../../application/errors';
import type { WalletRepository } from '../../../application/ports/wallet-repository';
import type { Wallet } from '../../../domain/wallet/wallet';
import { toWallet, toWalletRecord } from '../mappers';
import type { MikroOrmUnitOfWork } from '../mikro-orm-unit-of-work';
import { WalletRecord } from '../records';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.uow.em().insert(WalletRecord, toWalletRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.uow.em().findOne(WalletRecord, { id });
    return record ? toWallet(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.uow
      .em()
      .findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? toWallet(record) : undefined;
  }

  // The version in the WHERE clause is a second line of defense. Under the row lock it
  // always matches; if it ever does not, the write is refused instead of overwriting.
  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.uow.em().nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new StaleWalletVersionError(wallet.id);
    }
  }
}
