// Resumes transactions whose reference had not arrived. Candidates are listed without any
// lock; each one is then handled in its own SQL transaction that locks the wallet first and
// the transaction row second (the same order as SubmitWagerTransaction) and re-checks that
// it is still waiting and due, so several instances can run this at the same time.
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransactionFailed } from '../../domain/events/wager-transaction-failed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import type { WagerProcessor } from '../../domain/wagering/wager-processor';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import {
  StaleTransactionError,
  StaleWalletVersionError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../errors';
import { eventsFor } from '../events/wager-event-factory';
import { safely } from '../observability/safely';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { OutboxRepository } from '../ports/outbox-repository';
import type { TransactionRepository } from '../ports/transaction-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { WalletRepository } from '../ports/wallet-repository';

export const PENDING_REFERENCE_BATCH_SIZE = 20;

export interface ResolvePendingReferencesDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  processor: WagerProcessor;
  clock: Clock;
  ids: IdGenerator;
  metrics: Metrics;
  logger: Logger;
}

interface Candidate {
  id: string;
  walletId: string;
}

export class ResolvePendingReferences {
  constructor(private readonly deps: ResolvePendingReferencesDependencies) {}

  async execute(): Promise<number> {
    const { uow, transactions, clock } = this.deps;
    const due = await uow.read(() =>
      transactions.findDuePendingReferences(clock.now(), PENDING_REFERENCE_BATCH_SIZE),
    );
    for (const candidate of due) {
      await this.resolve(candidate);
    }
    return due.length;
  }

  private async resolve(candidate: Candidate): Promise<void> {
    const { logger } = this.deps;
    try {
      const resolved = await this.deps.uow.run(() => this.attempt(candidate));
      if (resolved) {
        this.record(resolved);
      }
    } catch (error) {
      if (error instanceof TransientInfrastructureError) {
        safely(() =>
          logger.warn('pending_reference.transient_failure', { transactionId: candidate.id }),
        );
        return;
      }
      if (error instanceof StaleWalletVersionError || error instanceof UniqueViolationError) {
        safely(() =>
          logger.warn('pending_reference.conflict', {
            transactionId: candidate.id,
            code: error.code,
          }),
        );
        return;
      }
      if (error instanceof StaleTransactionError) {
        safely(() => logger.warn('pending_reference.stale', { transactionId: candidate.id }));
        return;
      }
      safely(() =>
        logger.error('pending_reference.unexpected_failure', {
          transactionId: candidate.id,
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
      await this.markFailed(candidate);
    }
  }

  private async lockIfStillDue(candidate: Candidate) {
    const { wallets, transactions, clock } = this.deps;
    const wallet = await wallets.findByIdForUpdate(candidate.walletId);
    if (!wallet) {
      return undefined;
    }
    const transaction = await transactions.findByIdForUpdate(candidate.id);
    const now = clock.now();
    if (
      !transaction ||
      transaction.status !== WagerTransactionStatus.PendingReference ||
      !transaction.nextAttemptAt ||
      transaction.nextAttemptAt.getTime() > now.getTime()
    ) {
      return undefined;
    }
    return { wallet, transaction, now };
  }

  private async attempt(candidate: Candidate): Promise<WagerTransaction | undefined> {
    const { wallets, transactions, ledger, processor, ids } = this.deps;
    const locked = await this.lockIfStillDue(candidate);
    if (!locked) {
      return undefined;
    }
    const { wallet, transaction, now } = locked;

    const reference = transaction.referenceExternalTransactionId
      ? await transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        )
      : undefined;
    const referenceAlreadyReversed = reference
      ? await transactions.isReversed(reference.id)
      : false;

    const expectedVersion = wallet.version;
    const entry = processor.process({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      entryId: ids.next(),
      now,
    });

    await transactions.update(transaction);
    if (entry) {
      await wallets.updateBalance(wallet, expectedVersion);
      await ledger.insert(entry);
    }
    if (!transaction.isTerminal()) {
      return undefined;
    }
    await this.emit(eventsFor(transaction, wallet, entry, this.contextFor(transaction, now)));
    return transaction;
  }

  // A failure that is neither transient nor a business rule would otherwise be retried
  // forever. The transaction is closed as FAILED, which is terminal and auditable.
  private async markFailed(candidate: Candidate): Promise<void> {
    const { uow, transactions, logger } = this.deps;
    try {
      const failed = await uow.run(async () => {
        const locked = await this.lockIfStillDue(candidate);
        if (!locked) {
          return undefined;
        }
        const { wallet, transaction, now } = locked;
        transaction.fail(FailureCode.InternalError, wallet.balance, now);
        await transactions.update(transaction);
        await this.emit([
          WagerTransactionFailed.from(transaction, this.contextFor(transaction, now)()),
        ]);
        return transaction;
      });
      if (failed) {
        this.record(failed);
      }
    } catch (error) {
      safely(() =>
        logger.error('pending_reference.mark_failed_failed', {
          transactionId: candidate.id,
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }

  private contextFor(transaction: WagerTransaction, now: Date): () => EventContext {
    return () => ({
      eventId: this.deps.ids.next(),
      correlationId: transaction.correlationId,
      causationId: transaction.id,
      occurredAt: now,
    });
  }

  private async emit(events: IntegrationEvent<unknown>[]): Promise<void> {
    for (const event of events) {
      await this.deps.outbox.insert(OutboxMessage.enqueue(event));
    }
  }

  private record(transaction: WagerTransaction): void {
    const { metrics, logger } = this.deps;
    safely(() => metrics.transactionRecorded(transaction.status, transaction.kind, 'worker'));
    safely(() =>
      logger.info('wager.transaction', {
        correlationId: transaction.correlationId,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        status: transaction.status,
        kind: transaction.kind,
        source: 'worker',
        failureCode: transaction.failureCode,
      }),
    );
  }
}
