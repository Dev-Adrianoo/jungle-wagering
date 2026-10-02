import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { call, startTestApp, type TestApp } from '../../support/http-app';

let db: TestDatabase;
let app: TestApp;

beforeAll(async () => {
  db = await createTestDatabase();
  app = await startTestApp(db);
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

describe('health', () => {
  test('GET /health/live answers while the process is up', async () => {
    const response = await call(app, 'GET', '/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  test('GET /health/ready reports PostgreSQL as reachable', async () => {
    const response = await call(app, 'GET', '/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { postgres: 'up' } });
  });
});

describe('correlation id', () => {
  test('echoes a well-formed id sent by the caller', async () => {
    const response = await call(app, 'GET', '/health/live', {
      headers: { 'x-correlation-id': 'trace-123' },
    });
    expect(response.headers.get('x-correlation-id')).toBe('trace-123');
  });

  test('generates one when the caller sends none', async () => {
    const response = await call(app, 'GET', '/health/live');
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('replaces an id that is not well formed', async () => {
    const response = await call(app, 'GET', '/health/live', {
      headers: { 'x-correlation-id': 'has spaces and <tags>' },
    });
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errors', () => {
  test('a body over the size limit answers 413 as problem+json', async () => {
    const rawBody = JSON.stringify({ padding: 'x'.repeat(150 * 1024) });
    const response = await call(app, 'POST', '/wallets', {
      rawBody,
      headers: { 'x-correlation-id': 'trace-413' },
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.body.correlationId).toBe('trace-413');
  });

  test('an unknown route answers 404 as problem+json with the correlation id', async () => {
    const response = await call(app, 'GET', '/nope', {
      headers: { 'x-correlation-id': 'trace-404' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body).toEqual({
      type: 'urn:wagering:problem:not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Not found',
      correlationId: 'trace-404',
    });
  });
});
