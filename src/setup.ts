// One-shot preparation run before the application instances start: applies the migrations
// and creates the queues. Both steps are idempotent, so it is safe to run on every deploy.
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from './config/config';
import { buildOrmConfig } from './infrastructure/persistence/orm.config';
import { ensureQueues } from './infrastructure/sqs/queues';
import { createSqsClient } from './infrastructure/sqs/sqs-client';

const config = loadConfig();

const orm = await MikroORM.init(buildOrmConfig(config.databaseUrl));
try {
  const applied = await orm.getMigrator().up();
  console.log(`applied ${applied.length} migration(s)`);
} finally {
  await orm.close(true);
}

const sqs = createSqsClient(config.sqs);
try {
  const urls = await ensureQueues(sqs, config.sqs);
  console.log(`queues ready: ${Object.keys(urls).join(', ')}`);
} finally {
  sqs.destroy();
}
