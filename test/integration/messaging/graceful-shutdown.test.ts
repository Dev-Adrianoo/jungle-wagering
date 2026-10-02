// SIGTERM does not exist on Windows, so this signal-level proof runs on Linux (CI or the
// container). The shutdown routine itself is covered on every platform in workers.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { createTestQueues, type TestQueues } from '../../support/sqs';
import { waitFor } from '../../support/wait-for';

let db: TestDatabase;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
});

afterAll(async () => {
  await queues.destroy();
  await db.drop();
});

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

describe.skipIf(process.platform === 'win32')('SIGTERM', () => {
  test('stops the workers, closes the connections and exits on its own', async () => {
    const port = await freePort();
    const child = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: db.databaseUrl,
        SQS_ENDPOINT: queues.config.endpoint,
        SQS_TRANSACTIONS_QUEUE: queues.config.transactionsQueue,
        SQS_DLQ_QUEUE: queues.config.deadLetterQueue,
        SQS_EVENTS_QUEUE: queues.config.eventsQueue,
        SQS_WAIT_TIME_SECONDS: '1',
        WORKERS_ENABLED: 'true',
        LOG_LEVEL: 'info',
        RUN_ID: randomUUID(),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let output = '';
    const reader = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk);
      }
    })();

    await waitFor(async () => output.includes('app.listening'), {
      timeoutMs: 30_000,
      description: 'the app to listen',
    });
    child.kill('SIGTERM');
    await Promise.race([
      child.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('did not exit')), 20_000)),
    ]);
    await reader;

    expect(output).toContain('workers.started');
    expect(output).toContain('workers.stopped');
    expect(output).not.toContain('"level":"error"');
  });
});
