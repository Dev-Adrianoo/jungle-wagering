import type { Wallet } from '../../wallet/wallet';
import type { LedgerDirection } from '../../wallet/wallet-ledger-entry';
import { FailureCode } from '../failure-code';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction';

export interface PolicyContext {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
}

export type WagerDecision =
  | {
      type: 'APPLY';
      direction: LedgerDirection | undefined;
      referenceTransactionId: string | undefined;
    }
  | { type: 'REJECT'; code: FailureCode }
  | { type: 'AWAIT_REFERENCE' };

export interface WagerPolicy {
  readonly kind: WagerTransactionKind;
  decide(context: PolicyContext): WagerDecision;
}

export interface ReferenceRules {
  allowedKinds: readonly WagerTransactionKind[];
  requireSameAmount: boolean;
  rejectIfAlreadyReversed: boolean;
}

export type ReferenceResolution = { reference: WagerTransaction } | { blocked: WagerDecision };

const rejected = (code: FailureCode): ReferenceResolution => ({
  blocked: { type: 'REJECT', code },
});

const WAITING: ReferenceResolution = { blocked: { type: 'AWAIT_REFERENCE' } };

/**
 * Validates the referenced transaction. The reference was looked up by the same
 * providerId, so the provider already matches.
 */
export function resolveReference(
  context: PolicyContext,
  rules: ReferenceRules,
): ReferenceResolution {
  const { transaction, reference } = context;
  if (!reference) {
    return WAITING;
  }
  if (
    reference.walletId !== transaction.walletId ||
    reference.playerId !== transaction.playerId ||
    reference.money.currency !== transaction.money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return rejected(FailureCode.ReferenceMismatch);
  }
  if (!rules.allowedKinds.includes(reference.kind)) {
    return rejected(FailureCode.ReferenceKindNotAllowed);
  }
  if (!reference.isTerminal()) {
    return WAITING;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return rejected(FailureCode.ReferenceNotProcessed);
  }
  if (rules.requireSameAmount && !reference.money.equals(transaction.money)) {
    return rejected(FailureCode.ReferenceAmountMismatch);
  }
  if (rules.rejectIfAlreadyReversed && context.referenceAlreadyReversed) {
    return rejected(FailureCode.ReferenceAlreadyReversed);
  }
  return { reference };
}
