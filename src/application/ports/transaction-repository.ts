import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

export interface TransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  isReversed(referenceTransactionId: string): Promise<boolean>;
}
