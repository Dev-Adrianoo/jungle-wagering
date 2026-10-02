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
}
