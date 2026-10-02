import { LedgerDirection } from '../../wallet/wallet-ledger-entry';
import { WagerTransactionKind } from '../wager-transaction';
import type { WagerDecision, WagerPolicy } from './wager-policy';

export class BetPolicy implements WagerPolicy {
  readonly kind = WagerTransactionKind.Bet;

  decide(): WagerDecision {
    return { type: 'APPLY', direction: LedgerDirection.Debit, referenceTransactionId: undefined };
  }
}
