// SIGTERM does not exist on Windows, so this signal-level proof runs on Linux (CI or the
// container). The shutdown routine itself is covered on every platform in workers.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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

const repoRoot = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

function capture(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.text += decoder.decode(chunk, { stream: true });
    }
  })();
}

function tail(text: string): string {
  return text.split('\n').slice(-30).join('\n');
}

// Nest answers a signal by running its shutdown hooks and then re-raising the same signal on
// the process, so a graceful end is reported as death by SIGTERM rather
// than as exit code 0; Bun reports it as signalCode SIGTERM with a null exitCode.
describe.skipIf(process.platform === 'win32')('SIGTERM', () => {
  test('stops the workers, closes the connections and exits on its own', async () => {
    const port = await freePort();
    const child = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: repoRoot,
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
    const stdout = { text: '' };
    const stderr = { text: '' };
    const drained = Promise.all([capture(child.stdout, stdout), capture(child.stderr, stderr)]);
    const diagnostics = () =>
      `\n--- stderr ---\n${tail(stderr.text)}\n--- stdout (tail) ---\n${tail(stdout.text)}`;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await waitFor(async () => stdout.text.includes('app.listening'), {
        timeoutMs: 30_000,
        description: `the app to listen${diagnostics()}`,
      });
      child.kill('SIGTERM');
      const exited = await Promise.race([
        child.exited.then(() => 'exited'),
        new Promise<string>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout('timeout'), 20_000);
        }),
      ]);
      if (exited === 'timeout') {
        throw new Error(`the process did not exit within 20s of SIGTERM${diagnostics()}`);
      }
      await drained;

      expect(`signalCode=${child.signalCode} exitCode=${child.exitCode}`, diagnostics()).toBe(
        `signalCode=SIGTERM exitCode=${null}`,
      );
      const order = ['workers.started', 'app.listening', 'workers.stopped'].map((event) =>
        stdout.text.indexOf(event),
      );
      expect(
        order.every(
          (position, index) => position >= 0 && (index === 0 || position > (order[index - 1] ?? 0)),
        ),
        `shutdown lines missing or out of order${diagnostics()}`,
      ).toBe(true);
      expect(stdout.text, diagnostics()).not.toContain('"level":"error"');
      expect(stderr.text, diagnostics()).not.toContain('"level":"error"');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  });
});
