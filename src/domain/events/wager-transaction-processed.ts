import type { MoneyProps } from '../money/money';
import {
  InvalidTransactionStateError,
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed || !transaction.processedAt) {
      throw new InvalidTransactionStateError(
        `transaction ${transaction.id} is ${transaction.status}, not PROCESSED`,
      );
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        ...(transaction.roundId === undefined ? {} : { roundId: transaction.roundId }),
        ...(transaction.gameId === undefined ? {} : { gameId: transaction.gameId }),
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        balance: transaction.observedBalance.toJSON(),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
        processedAt: transaction.processedAt.toISOString(),
      },
    });
  }
}
