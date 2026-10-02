// Single entry point for wager transactions, shared by HTTP and (in plan 2) by SQS.
// Order inside the SQL transaction: idempotency lookup, wallet row lock, the same lookup
// again under the lock, domain decision, then transaction + balance + ledger + outbox.
// Nothing is published here: the outbox worker does that after the commit.
import type { EventContext } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { WagerProcessor } from '../../domain/wagering/wager-processor';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  UniqueViolationError,
  WalletNotFoundError,
} from '../errors';
import { eventsFor } from '../events/wager-event-factory';
import {
  hashWagerPayload,
  type SubmittableKind,
  type WagerPayload,
} from '../idempotency/payload-hash';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { OutboxRepository } from '../ports/outbox-repository';
import type { TransactionRepository } from '../ports/transaction-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { WalletRepository } from '../ports/wallet-repository';
import { type SubmitWagerResult, toSubmitResult } from '../views';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  correlationId: string;
  source: 'http' | 'sqs';
}

export interface SubmitWagerDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  processor: WagerProcessor;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  metrics: Metrics;
}

const KINDS: Record<SubmittableKind, WagerTransactionKind> = {
  BET: WagerTransactionKind.Bet,
  WIN: WagerTransactionKind.Win,
  LOSS: WagerTransactionKind.Loss,
  REFUND: WagerTransactionKind.Refund,
  ROLLBACK: WagerTransactionKind.Rollback,
};

export const IDEMPOTENCY_CONSTRAINTS = new Set([
  'wager_tx_idempotency_key_unique',
  'wager_tx_provider_external_unique',
]);

export class SubmitWagerTransaction {
  constructor(private readonly deps: SubmitWagerDependencies) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = performance.now();
    try {
      const result = await this.submit(command);
      this.record(command, result);
      return result;
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        this.deps.metrics.idempotencyConflict();
      }
      throw error;
    } finally {
      this.deps.metrics.processingObserved((performance.now() - startedAt) / 1000, command.source);
    }
  }

  // Two requests with the same key can both pass the lookup when they lock different
  // wallets. The unique constraint stops the second one; running it again makes it find
  // the first and answer with a replay or a conflict.
  private async submit(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const payloadHash = hashWagerPayload(command.payload);
    try {
      return await this.attempt(command, payloadHash);
    } catch (error) {
      if (error instanceof UniqueViolationError && IDEMPOTENCY_CONSTRAINTS.has(error.constraint)) {
        return this.attempt(command, payloadHash);
      }
      throw error;
    }
  }

  private record(command: SubmitWagerCommand, result: SubmitWagerResult): void {
    const { logger, metrics } = this.deps;
    const fields = {
      transactionId: result.transactionId,
      walletId: command.payload.walletId,
      providerId: command.payload.providerId,
      status: result.status,
      kind: command.payload.kind,
      source: command.source,
      failureCode: result.failureCode,
    };
    if (result.idempotentReplay) {
      metrics.duplicateDetected(command.source);
      logger.info('wager.replay', fields);
      return;
    }
    metrics.transactionRecorded(result.status, command.payload.kind, command.source);
    logger.info('wager.transaction', fields);
  }

  private attempt(command: SubmitWagerCommand, payloadHash: string): Promise<SubmitWagerResult> {
    const { uow, wallets, transactions, ledger, outbox, processor, clock, ids } = this.deps;
    const { payload } = command;

    return uow.run(async () => {
      const replayBeforeLock = await this.findReplay(command, payloadHash);
      if (replayBeforeLock) {
        return replayBeforeLock;
      }

      const wallet = await wallets.findByIdForUpdate(payload.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(payload.walletId);
      }

      const replayUnderLock = await this.findReplay(command, payloadHash);
      if (replayUnderLock) {
        return replayUnderLock;
      }
      if (
        await transactions.findByProviderAndExternalId(
          payload.providerId,
          payload.externalTransactionId,
        )
      ) {
        throw new DuplicateExternalTransactionError(
          payload.providerId,
          payload.externalTransactionId,
        );
      }

      const now = clock.now();
      const transaction = WagerTransaction.create({
        id: ids.next(),
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: payload.walletId,
        playerId: payload.playerId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: KINDS[payload.kind],
        money: Money.from(payload.money),
        referenceExternalTransactionId: payload.referenceExternalTransactionId,
        correlationId: command.correlationId,
        createdAt: now,
      });

      const reference = payload.referenceExternalTransactionId
        ? await transactions.findByProviderAndExternalId(
            payload.providerId,
            payload.referenceExternalTransactionId,
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

      await transactions.insert(transaction);
      if (entry) {
        await wallets.updateBalance(wallet, expectedVersion);
        await ledger.insert(entry);
      }
      const newContext = (): EventContext => ({
        eventId: ids.next(),
        correlationId: command.correlationId,
        causationId: transaction.id,
        occurredAt: now,
      });
      for (const event of eventsFor(transaction, wallet, entry, newContext)) {
        await outbox.insert(OutboxMessage.enqueue(event));
      }
      return toSubmitResult(transaction, false);
    });
  }

  private async findReplay(
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<SubmitWagerResult | undefined> {
    const existing = await this.deps.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (!existing) {
      return undefined;
    }
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyKeyConflictError(command.idempotencyKey);
    }
    return toSubmitResult(existing, true);
  }
}
