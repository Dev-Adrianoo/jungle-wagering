import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { MIGRATIONS } from './migrations';
import {
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './records';

export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxMessageSchema],
    extensions: [Migrator],
    forceUtcTimezone: true,
    pool: { min: 2, max: 20 },
    migrations: {
      tableName: 'schema_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
      snapshot: false,
    },
  });
}
