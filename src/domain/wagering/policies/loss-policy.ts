import { WagerTransactionKind } from '../wager-transaction';
import {
  type PolicyContext,
  resolveReference,
  type WagerDecision,
  type WagerPolicy,
} from './wager-policy';

export class LossPolicy implements WagerPolicy {
  readonly kind = WagerTransactionKind.Loss;

  decide(context: PolicyContext): WagerDecision {
    if (!context.transaction.referenceExternalTransactionId) {
      return { type: 'APPLY', direction: undefined, referenceTransactionId: undefined };
    }
    const resolution = resolveReference(context, {
      allowedKinds: [WagerTransactionKind.Bet],
      requireSameAmount: false,
      rejectIfAlreadyReversed: false,
    });
    if ('blocked' in resolution) {
      return resolution.blocked;
    }
    return { type: 'APPLY', direction: undefined, referenceTransactionId: resolution.reference.id };
  }
}
