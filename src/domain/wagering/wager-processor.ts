import { InsufficientFundsError, type Wallet } from '../wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import type { PolicyContext, WagerDecision, WagerPolicy } from './policies/wager-policy';
import {
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface ProcessInput extends PolicyContext {
  entryId: string;
  now: Date;
}

/**
 * Applies one transaction to its wallet. Leaves the transaction in PROCESSED,
 * REJECTED or PENDING_REFERENCE and returns the ledger entry when the balance moved.
 */
export class WagerProcessor {
  private readonly policies: ReadonlyMap<WagerTransactionKind, WagerPolicy>;

  constructor(policies: readonly WagerPolicy[]) {
    this.policies = new Map(policies.map((policy) => [policy.kind, policy]));
  }

  process(input: ProcessInput): WalletLedgerEntry | undefined {
    const { transaction, wallet, now } = input;
    const policy = this.policies.get(transaction.kind);
    if (!policy) {
      throw new InvalidWagerTransactionError(`no policy registered for ${transaction.kind}`);
    }
    if (transaction.money.currency !== wallet.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, wallet.balance, now);
      return undefined;
    }
    if (transaction.playerId !== wallet.playerId) {
      transaction.reject(FailureCode.PlayerWalletMismatch, wallet.balance, now);
      return undefined;
    }

    const decision = policy.decide(input);
    switch (decision.type) {
      case 'REJECT':
        transaction.reject(decision.code, wallet.balance, now);
        return undefined;
      case 'AWAIT_REFERENCE':
        if (transaction.status === WagerTransactionStatus.Pending) {
          transaction.markPendingReference(wallet.balance, now);
        } else {
          transaction.registerReferenceMiss(wallet.balance, now);
        }
        return undefined;
      case 'APPLY':
        return this.apply(transaction, wallet, decision, input.entryId, now);
    }
  }

  private apply(
    transaction: WagerTransaction,
    wallet: Wallet,
    decision: Extract<WagerDecision, { type: 'APPLY' }>,
    entryId: string,
    now: Date,
  ): WalletLedgerEntry | undefined {
    if (decision.direction === undefined) {
      transaction.markProcessed(decision.referenceTransactionId, wallet.balance, now);
      return undefined;
    }
    const ref = { transactionId: transaction.id, entryId, at: now };
    try {
      const entry =
        decision.direction === LedgerDirection.Debit
          ? wallet.debit(transaction.money, ref)
          : wallet.credit(transaction.money, ref);
      transaction.markProcessed(decision.referenceTransactionId, wallet.balance, now);
      return entry;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        const code =
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalInsufficientFunds;
        transaction.reject(code, wallet.balance, now);
        return undefined;
      }
      throw error;
    }
  }
}
