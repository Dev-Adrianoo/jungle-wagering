// The single place where repositories and use cases are wired. NestJS and the tests both
// build the application through here, so there is one wiring to keep correct.
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../application/ports/clock';
import type { IdGenerator } from '../application/ports/id-generator';
import type { LedgerRepository } from '../application/ports/ledger-repository';
import type { Logger } from '../application/ports/logger';
import type { Metrics } from '../application/ports/metrics';
import type { OutboxRepository } from '../application/ports/outbox-repository';
import type { TransactionRepository } from '../application/ports/transaction-repository';
import type { UnitOfWork } from '../application/ports/unit-of-work';
import type { WalletRepository } from '../application/ports/wallet-repository';
import { TransactionQueries } from '../application/queries/transaction-queries';
import { WalletQueries } from '../application/queries/wallet-queries';
import { OpenWallet } from '../application/use-cases/open-wallet';
import { ReconcileWallet } from '../application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from '../application/use-cases/submit-wager-transaction';
import { defaultPolicies } from '../domain/wagering/policies/default-policies';
import { WagerProcessor } from '../domain/wagering/wager-processor';
import { NoopMetrics } from '../infrastructure/observability/noop-metrics';
import { SilentLogger } from '../infrastructure/observability/silent-logger';
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
  logger?: Logger;
  metrics?: Metrics;
}

export interface Core {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  logger: Logger;
  metrics: Metrics;
  openWallet: OpenWallet;
  walletQueries: WalletQueries;
  transactionQueries: TransactionQueries;
  reconcileWallet: ReconcileWallet;
  submitWager: SubmitWagerTransaction;
}

export function buildCore(orm: MikroORM, options: CoreOptions): Core {
  const logger = options.logger ?? new SilentLogger();
  const metrics = options.metrics ?? new NoopMetrics();
  const uow = new MikroOrmUnitOfWork(orm, options.lockTimeoutMs, () => metrics.lockConflict());
  const clock = options.clock ?? new SystemClock();
  const ids = options.ids ?? new UuidV7IdGenerator();
  const wallets = new MikroOrmWalletRepository(uow);
  const transactions = new MikroOrmTransactionRepository(uow);
  const ledger = new MikroOrmLedgerRepository(uow);
  const outbox = options.outbox ?? new MikroOrmOutboxRepository(uow);
  const processor = new WagerProcessor(defaultPolicies());
  return {
    uow,
    clock,
    ids,
    wallets,
    transactions,
    ledger,
    outbox,
    logger,
    metrics,
    openWallet: new OpenWallet({ uow, wallets, transactions, ledger, outbox, clock, ids }),
    walletQueries: new WalletQueries(uow, wallets, ledger),
    transactionQueries: new TransactionQueries(uow, transactions),
    reconcileWallet: new ReconcileWallet(uow, ledger, logger, metrics),
    submitWager: new SubmitWagerTransaction({
      uow,
      wallets,
      transactions,
      ledger,
      outbox,
      processor,
      clock,
      ids,
      logger,
      metrics,
    }),
  };
}
