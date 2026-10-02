import { WagerTransactionKind } from '../wager-transaction';
import {
  type PolicyContext,
  resolveReference,
  type WagerDecision,
  type WagerPolicy,
} from './wager-policy';

export class RollbackPolicy implements WagerPolicy {
  readonly kind = WagerTransactionKind.Rollback;

  decide(context: PolicyContext): WagerDecision {
    const resolution = resolveReference(context, {
      allowedKinds: [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ],
      requireSameAmount: true,
      rejectIfAlreadyReversed: true,
    });
    if ('blocked' in resolution) {
      return resolution.blocked;
    }
    return {
      type: 'APPLY',
      direction: context.transaction.ledgerDirectionFor(resolution.reference),
      referenceTransactionId: resolution.reference.id,
    };
  }
}
