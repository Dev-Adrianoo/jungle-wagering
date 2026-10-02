import { LedgerDirection } from '../../wallet/wallet-ledger-entry';
import { WagerTransactionKind } from '../wager-transaction';
import {
  type PolicyContext,
  resolveReference,
  type WagerDecision,
  type WagerPolicy,
} from './wager-policy';

export class WinPolicy implements WagerPolicy {
  readonly kind = WagerTransactionKind.Win;

  decide(context: PolicyContext): WagerDecision {
    if (!context.transaction.referenceExternalTransactionId) {
      return {
        type: 'APPLY',
        direction: LedgerDirection.Credit,
        referenceTransactionId: undefined,
      };
    }
    const resolution = resolveReference(context, {
      allowedKinds: [WagerTransactionKind.Bet],
      requireSameAmount: false,
      rejectIfAlreadyReversed: false,
    });
    if ('blocked' in resolution) {
      return resolution.blocked;
    }
    return {
      type: 'APPLY',
      direction: LedgerDirection.Credit,
      referenceTransactionId: resolution.reference.id,
    };
  }
}
