import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wagering/failure-code';
import {
  InvalidTransactionStateError,
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionFailedData {
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
  failureCode: FailureCode;
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionFailed {
    if (transaction.status !== WagerTransactionStatus.Failed || !transaction.failureCode) {
      throw new InvalidTransactionStateError(
        `transaction ${transaction.id} is ${transaction.status}, not FAILED`,
      );
    }
    return new WagerTransactionFailed({
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
        failureCode: transaction.failureCode,
      },
    });
  }
}
