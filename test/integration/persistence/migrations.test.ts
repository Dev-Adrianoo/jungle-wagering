import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../../support/database';

const APP_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

describe('migrations', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function appTables(): Promise<string[]> {
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name <> 'schema_migrations'
       order by table_name`,
    );
    return rows.map((row) => row.table_name);
  }

  test('up creates every table', async () => {
    expect(await appTables()).toEqual(APP_TABLES);
  });

  test('down removes everything and up restores it', async () => {
    const migrator = db.orm.getMigrator();

    await migrator.down({ to: 0 });
    expect(await appTables()).toEqual([]);

    await migrator.up();
    expect(await appTables()).toEqual(APP_TABLES);
  });
});
