import {
  InvalidTransactionStateError,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../wagering/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId || !transaction.nextAttemptAt) {
      throw new InvalidTransactionStateError(
        `transaction ${transaction.id} is not waiting for a reference`,
      );
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        nextAttemptAt: transaction.nextAttemptAt.toISOString(),
      },
    });
  }
}
