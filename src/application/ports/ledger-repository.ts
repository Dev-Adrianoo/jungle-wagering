import type { Money } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface LedgerPage {
  entries: Array<{ seq: string; entry: WalletLedgerEntry }>;
  hasMore: boolean;
}

export interface LedgerSummary {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  summarize(walletId: string): Promise<LedgerSummary | undefined>;
}
