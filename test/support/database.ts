import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/persistence/orm.config';

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5440/wagering';

export interface TestDatabase {
  orm: MikroORM;
  databaseUrl: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

async function withAdmin(run: (admin: MikroORM) => Promise<void>): Promise<void> {
  const admin = await MikroORM.init(buildOrmConfig(BASE_URL, { silentMigrations: true }));
  try {
    await run(admin);
  } finally {
    await admin.close(true);
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `wagering_test_${randomUUID().replaceAll('-', '')}`;
  await withAdmin(async (admin) => {
    await admin.em.getConnection().execute(`create database "${name}"`);
  });

  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();

  const orm = await MikroORM.init(buildOrmConfig(databaseUrl, { silentMigrations: true }));
  await orm.getMigrator().up();

  return {
    orm,
    databaseUrl,
    query: <T>(sql: string, params: unknown[] = []) =>
      orm.em.getConnection().execute(sql, params) as Promise<T[]>,
    drop: async () => {
      await orm.close(true);
      await withAdmin(async (admin) => {
        await admin.em.getConnection().execute(`drop database if exists "${name}" with (force)`);
      });
    },
  };
}
