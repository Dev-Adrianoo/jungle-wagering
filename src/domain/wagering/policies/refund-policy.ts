import { LedgerDirection } from '../../wallet/wallet-ledger-entry';
import { WagerTransactionKind } from '../wager-transaction';
import {
  type PolicyContext,
  resolveReference,
  type WagerDecision,
  type WagerPolicy,
} from './wager-policy';

export class RefundPolicy implements WagerPolicy {
  readonly kind = WagerTransactionKind.Refund;

  decide(context: PolicyContext): WagerDecision {
    const resolution = resolveReference(context, {
      allowedKinds: [WagerTransactionKind.Bet],
      requireSameAmount: true,
      rejectIfAlreadyReversed: true,
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
