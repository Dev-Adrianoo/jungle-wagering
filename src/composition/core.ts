// The single place where repositories and use cases are wired. NestJS and the tests both
// build the application through here, so there is one wiring to keep correct.
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../application/ports/clock';
import type { IdGenerator } from '../application/ports/id-generator';
import type { LedgerRepository } from '../application/ports/ledger-repository';
import type { OutboxRepository } from '../application/ports/outbox-repository';
import type { TransactionRepository } from '../application/ports/transaction-repository';
import type { UnitOfWork } from '../application/ports/unit-of-work';
import type { WalletRepository } from '../application/ports/wallet-repository';
import { MikroOrmUnitOfWork } from '../infrastructure/persistence/mikro-orm-unit-of-work';
import { MikroOrmLedgerRepository } from '../infrastructure/persistence/repositories/ledger-repository';
import { MikroOrmOutboxRepository } from '../infrastructure/persistence/repositories/outbox-repository';
import { MikroOrmTransactionRepository } from '../infrastructure/persistence/repositories/transaction-repository';
import { MikroOrmWalletRepository } from '../infrastructure/persistence/repositories/wallet-repository';
import { SystemClock } from '../infrastructure/system/system-clock';
import { UuidV7IdGenerator } from '../infrastructure/system/uuid-v7-id-generator';

export interface CoreOptions {
  lockTimeoutMs: number;
  clock?: Clock;
  ids?: IdGenerator;
  outbox?: OutboxRepository;
}

export interface Core {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

export function buildCore(orm: MikroORM, options: CoreOptions): Core {
  const uow = new MikroOrmUnitOfWork(orm, options.lockTimeoutMs);
  return {
    uow,
    clock: options.clock ?? new SystemClock(),
    ids: options.ids ?? new UuidV7IdGenerator(),
    wallets: new MikroOrmWalletRepository(uow),
    transactions: new MikroOrmTransactionRepository(uow),
    ledger: new MikroOrmLedgerRepository(uow),
    outbox: options.outbox ?? new MikroOrmOutboxRepository(uow),
  };
}
