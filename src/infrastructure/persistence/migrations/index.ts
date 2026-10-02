// Migrations are listed explicitly instead of discovered on disk, so Bun, tests and Docker
// all load exactly the same set.
import { Migration20261001000001_wallets } from './Migration20261001000001_wallets';
import { Migration20261001000002_wager_transactions } from './Migration20261001000002_wager_transactions';
import { Migration20261001000003_wallet_ledger_entries } from './Migration20261001000003_wallet_ledger_entries';
import { Migration20261001000004_inbox_outbox } from './Migration20261001000004_inbox_outbox';

export const MIGRATIONS = [
  { name: 'Migration20261001000001_wallets', class: Migration20261001000001_wallets },
  {
    name: 'Migration20261001000002_wager_transactions',
    class: Migration20261001000002_wager_transactions,
  },
  {
    name: 'Migration20261001000003_wallet_ledger_entries',
    class: Migration20261001000003_wallet_ledger_entries,
  },
  { name: 'Migration20261001000004_inbox_outbox', class: Migration20261001000004_inbox_outbox },
];
