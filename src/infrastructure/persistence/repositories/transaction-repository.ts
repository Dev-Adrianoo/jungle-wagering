import { LockMode } from '@mikro-orm/core';
import { StaleTransactionError } from '../../../application/errors';
import type { TransactionRepository } from '../../../application/ports/transaction-repository';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { toTransaction, toTransactionRecord } from '../mappers';
import type { MikroOrmUnitOfWork } from '../mikro-orm-unit-of-work';
import { WagerTransactionRecord } from '../records';

export class MikroOrmTransactionRepository implements TransactionRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.uow.em().insert(WagerTransactionRecord, toTransactionRecord(transaction));
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.uow.em().findOne(WagerTransactionRecord, { id });
    return record ? toTransaction(record) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.uow.em().findOne(WagerTransactionRecord, { idempotencyKey });
    return record ? toTransaction(record) : undefined;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.uow
      .em()
      .findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toTransaction(record) : undefined;
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const reversals = await this.uow.em().count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return reversals > 0;
  }

  async findDuePendingReferences(
    now: Date,
    limit: number,
  ): Promise<Array<{ id: string; walletId: string }>> {
    const records = await this.uow
      .em()
      .find(
        WagerTransactionRecord,
        { status: 'PENDING_REFERENCE', nextAttemptAt: { $lte: now } },
        { orderBy: { nextAttemptAt: 'asc' }, limit, fields: ['id', 'walletId'] },
      );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.uow
      .em()
      .findOne(WagerTransactionRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? toTransaction(record) : undefined;
  }

  // Only the columns a waiting transaction may change are written, and only while the row
  // is still waiting: a concurrent resolver that already finished it makes this a no-op
  // that is reported instead of overwriting a terminal row.
  async update(transaction: WagerTransaction): Promise<void> {
    const record = toTransactionRecord(transaction);
    const affected = await this.uow.em().nativeUpdate(
      WagerTransactionRecord,
      { id: record.id, status: 'PENDING_REFERENCE' },
      {
        status: record.status,
        failureCode: record.failureCode,
        referenceTransactionId: record.referenceTransactionId,
        observedBalance: record.observedBalance,
        observedBalanceCurrency: record.observedBalanceCurrency,
        referenceAttempts: record.referenceAttempts,
        nextAttemptAt: record.nextAttemptAt,
        updatedAt: record.updatedAt,
        processedAt: record.processedAt,
      },
    );
    if (affected !== 1) {
      throw new StaleTransactionError(record.id);
    }
  }
}
