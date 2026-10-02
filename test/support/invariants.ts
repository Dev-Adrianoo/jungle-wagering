import { expect } from 'bun:test';
import type { TestDatabase } from './database';

export async function expectLedgerMatchesBalance(
  db: TestDatabase,
  walletId: string,
): Promise<void> {
  const rows = await db.query<{ balance: string; ledger: string }>(
    `select w.balance::text as balance,
            coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)
              ::numeric(20,2)::text as ledger
     from wallets w
     left join wallet_ledger_entries e on e.wallet_id = w.id
     where w.id = ?
     group by w.id`,
    [walletId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.ledger).toBe(rows[0]?.balance as string);
}
