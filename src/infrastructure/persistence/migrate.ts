import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config/config';
import { buildOrmConfig } from './orm.config';

const direction = process.argv[2] ?? 'up';
const orm = await MikroORM.init(buildOrmConfig(loadConfig().databaseUrl));

try {
  const migrator = orm.getMigrator();
  if (direction === 'up') {
    const applied = await migrator.up();
    console.log(`applied ${applied.length} migration(s)`);
  } else if (direction === 'down') {
    const reverted = await migrator.down();
    console.log(`reverted ${reverted.length} migration(s)`);
  } else {
    throw new Error(`unknown direction "${direction}", expected "up" or "down"`);
  }
} finally {
  await orm.close(true);
}
