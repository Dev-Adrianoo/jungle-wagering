// Starts real application processes (`bun run src/main.ts`) against one database and one
// set of queues. Nothing here is mocked: the processes only share PostgreSQL and SQS, which
// is exactly the situation the system has to stay correct in. Every child's stdout and stderr
// are drained for its whole life and kept, so a failure always carries the output of the
// process that caused it, and stopAll() kills every child that is still alive, including the
// ones that were taken out of rotation, so a failed run leaves no orphan process.
import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import type { TestDatabase } from './database';
import type { TestQueues } from './sqs';
import { waitFor } from './wait-for';

const repoRoot = resolve(import.meta.dir, '../..');

export interface LogEntry {
  level?: string;
  event?: string;
  [field: string]: unknown;
}

export interface ExitInfo {
  exitCode: number | null;
  signalCode: string | null;
}

export interface Instance {
  url: string;
  exited: Promise<number>;
  kill(): Promise<void>;
  terminate(): Promise<number>;
  output(): string;
  errorLines(): string[];
  entries(): LogEntry[];
  exitInfo(): ExitInfo;
}

export interface Cluster {
  instances: Instance[];
  add(env?: Record<string, string>): Promise<Instance>;
  post(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
  entries(event?: string): LogEntry[];
  errorLines(): string[];
  output(): string;
  stopAll(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}

async function isReady(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/health/ready`)).ok;
  } catch {
    return false;
  }
}

function capture(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      sink.text += decoder.decode(chunk, { stream: true });
    }
  })();
}

function parseEntries(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {}
  }
  return entries;
}

function tail(text: string): string {
  return text.split('\n').slice(-30).join('\n');
}

export async function startCluster(options: {
  db: TestDatabase;
  queues: TestQueues;
  size: number;
  env?: Record<string, string>;
}): Promise<Cluster> {
  const { db, queues } = options;
  const alive = new Set<Instance>();
  const everyone: Instance[] = [];
  const children: Subprocess[] = [];
  let next = 0;

  async function add(env: Record<string, string> = {}): Promise<Instance> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: db.databaseUrl,
        SQS_ENDPOINT: queues.config.endpoint ?? '',
        AWS_REGION: queues.config.region,
        SQS_TRANSACTIONS_QUEUE: queues.config.transactionsQueue,
        SQS_DLQ_QUEUE: queues.config.deadLetterQueue,
        SQS_EVENTS_QUEUE: queues.config.eventsQueue,
        SQS_WAIT_TIME_SECONDS: '1',
        WORKERS_ENABLED: 'true',
        LOG_LEVEL: 'info',
        ...options.env,
        ...env,
      },
    });
    children.push(child);
    const stdout = { text: '' };
    const stderr = { text: '' };
    void Promise.all([capture(child.stdout, stdout), capture(child.stderr, stderr)]);
    const instance: Instance = {
      url,
      exited: child.exited,
      kill: async () => {
        alive.delete(instance);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        await child.exited;
      },
      terminate: async () => {
        alive.delete(instance);
        child.kill('SIGTERM');
        return child.exited;
      },
      output: () =>
        `--- stderr ---\n${tail(stderr.text)}\n--- stdout (tail) ---\n${tail(stdout.text)}`,
      errorLines: () =>
        `${stdout.text}\n${stderr.text}`
          .split('\n')
          .filter((line) => line.includes('"level":"error"')),
      entries: () => parseEntries(stdout.text),
      exitInfo: () => ({ exitCode: child.exitCode, signalCode: child.signalCode }),
    };
    everyone.push(instance);
    void child.exited.then(() => alive.delete(instance));
    await waitFor(async () => (await isReady(url)) || child.exitCode !== null, {
      timeoutMs: 30_000,
      description: `instance on port ${port} to become ready\n${instance.output()}`,
    });
    if (child.exitCode === null) {
      alive.add(instance);
    }
    return instance;
  }

  function pick(): Instance {
    const candidates = [...alive];
    const instance = candidates[next % candidates.length];
    next += 1;
    if (!instance) {
      throw new Error('no live instance in the cluster');
    }
    return instance;
  }

  async function request(method: string, path: string, body?: unknown, headers = {}) {
    const response = await fetch(`${pick().url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const cluster: Cluster = {
    instances: [],
    add: async (env) => {
      const instance = await add(env);
      cluster.instances.push(instance);
      return instance;
    },
    post: (path, body, headers) => request('POST', path, body, headers),
    get: (path) => request('GET', path),
    entries: (event) =>
      everyone
        .flatMap((instance) => instance.entries())
        .filter((entry) => event === undefined || entry.event === event),
    errorLines: () => everyone.flatMap((instance) => instance.errorLines()),
    output: () => everyone.map((instance) => instance.output()).join('\n=====\n'),
    stopAll: async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
      await Promise.all(children.map((child) => child.exited));
      alive.clear();
    },
  };

  try {
    for (let index = 0; index < options.size; index += 1) {
      await cluster.add();
    }
  } catch (error) {
    await cluster.stopAll();
    throw error;
  }
  return cluster;
}
