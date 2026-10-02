import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { AppOverrides } from '../../src/interface/http/app.module';
import { createApp } from '../../src/interface/http/create-app';
import type { TestDatabase } from './database';
import { createTestQueues, type TestQueues } from './sqs';

export interface TestApp {
  baseUrl: string;
  queues: TestQueues;
  close(): Promise<void>;
}

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export async function startTestApp(
  db: TestDatabase,
  overrides: AppOverrides = {},
  queues?: TestQueues,
): Promise<TestApp> {
  const ownedQueues = queues ?? (await createTestQueues());
  const app = await createApp(
    {
      port: 0,
      databaseUrl: db.databaseUrl,
      lockTimeoutMs: 3000,
      authMode: 'noop',
      logLevel: 'silent',
      sqs: ownedQueues.config,
    },
    overrides,
  );
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    queues: ownedQueues,
    close: async () => {
      await app.close();
      if (queues === undefined) {
        await ownedQueues.destroy();
      }
    },
  };
}

export async function call(app: TestApp, method: string, path: string, options: CallOptions = {}) {
  const hasBody = options.body !== undefined || options.rawBody !== undefined;
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...options.headers },
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  const body: any = text ? JSON.parse(text) : undefined;
  return { status: response.status, headers: response.headers, body };
}
