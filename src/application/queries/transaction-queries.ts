import { TransactionNotFoundError } from '../errors';
import type { TransactionRepository } from '../ports/transaction-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { type TransactionView, toTransactionView } from '../views';

export class TransactionQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: TransactionRepository,
  ) {}

  getById(transactionId: string): Promise<TransactionView> {
    return this.uow.read(async () => {
      const transaction = await this.transactions.findById(transactionId);
      if (!transaction) {
        throw new TransactionNotFoundError(transactionId);
      }
      return toTransactionView(transaction);
    });
  }

  getByProvider(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.uow.read(async () => {
      const transaction = await this.transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
      }
      return toTransactionView(transaction);
    });
  }
}
