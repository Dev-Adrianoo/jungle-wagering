import type {
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
} from '../../../application/ports/ledger-repository';
import { Money } from '../../../domain/money/money';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { type LedgerEntryRow, toLedgerEntry, toLedgerEntryRecord } from '../mappers';
import type { MikroOrmUnitOfWork } from '../mikro-orm-unit-of-work';
import { LedgerEntryRecord } from '../records';

interface SummaryRow {
  stored: string;
  currency: string;
  calculated: string;
  entries: string | number;
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.uow.em().insert(LedgerEntryRecord, toLedgerEntryRecord(entry));
  }

  async page(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    const rows: LedgerEntryRow[] = await this.uow.em().execute(
      `select id, seq, wallet_id, transaction_id, wallet_version, direction, amount, currency,
              balance_before, balance_after, created_at
       from wallet_ledger_entries
       where wallet_id = ? and seq > ?
       order by seq asc
       limit ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    );
    return {
      entries: rows
        .slice(0, limit)
        .map((row) => ({ seq: String(row.seq), entry: toLedgerEntry(row) })),
      hasMore: rows.length > limit,
    };
  }

  // One statement reads the stored balance and the ledger sum from the same snapshot,
  // so a concurrent write cannot make a consistent wallet look divergent.
  async summarize(walletId: string): Promise<LedgerSummary | undefined> {
    const rows: SummaryRow[] = await this.uow.em().execute(
      `select w.balance as stored,
              w.currency as currency,
              coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)
                as calculated,
              count(e.id) as entries
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
       where w.id = ?
       group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      storedBalance: Money.from({ amount: row.stored, currency: row.currency }),
      calculatedBalance: Money.from({ amount: row.calculated, currency: row.currency }),
      entries: Number(row.entries),
    };
  }
}
