import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransactionFailed } from '../../domain/events/wager-transaction-failed';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import {
  InvalidTransactionStateError,
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export function eventsFor(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  newContext: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return entry
        ? [
            WagerTransactionProcessed.from(transaction, newContext()),
            WalletBalanceChanged.from(wallet, entry, newContext()),
          ]
        : [WagerTransactionProcessed.from(transaction, newContext())];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, newContext())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, newContext())];
    case WagerTransactionStatus.Failed:
      return [WagerTransactionFailed.from(transaction, newContext())];
    case WagerTransactionStatus.Pending:
      throw new InvalidTransactionStateError(
        `transaction ${transaction.id} is still PENDING and has no event to emit`,
      );
  }
}
