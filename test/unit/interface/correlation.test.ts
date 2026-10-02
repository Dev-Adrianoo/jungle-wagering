import { describe, expect, spyOn, test } from 'bun:test';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import { currentLogContext } from '../../../src/infrastructure/observability/log-context';
import {
  type CorrelatedRequest,
  correlationIdOf,
  correlationMiddleware,
} from '../../../src/interface/http/correlation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(headerValue: string | undefined, logger: Logger = silent) {
  const request = {
    method: 'POST',
    path: '/wagering/transactions',
    header: (name: string) => (name.toLowerCase() === 'x-correlation-id' ? headerValue : undefined),
  } as unknown as CorrelatedRequest;
  const headers: Record<string, string> = {};
  const listeners: Record<string, () => void> = {};
  const response = {
    statusCode: 201,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    on: (event: string, listener: () => void) => {
      listeners[event] = listener;
    },
  };
  let contextInsideRequest: LogFields = {};
  correlationMiddleware(logger)(request, response as never, () => {
    contextInsideRequest = { ...currentLogContext() };
  });
  return { request, headers, listeners, contextInsideRequest: () => contextInsideRequest };
}

const silent: Logger = { info() {}, warn() {}, error() {} };

describe('correlationMiddleware', () => {
  test('echoes a well-formed id and stores it on the request', () => {
    const { request, headers } = run('trace-123');

    expect(headers['X-Correlation-Id']).toBe('trace-123');
    expect(correlationIdOf(request)).toBe('trace-123');
  });

  test('accepts 128 characters and the whole safe alphabet', () => {
    expect(run('x'.repeat(128)).headers['X-Correlation-Id']).toBe('x'.repeat(128));
    expect(run('a.b_c:d-E9').headers['X-Correlation-Id']).toBe('a.b_c:d-E9');
  });

  test.each(['x'.repeat(129), 'bad id', 'ok bad', 'bad ok', '<tag>', '', undefined])(
    'replaces %p with a generated id',
    (received) => {
      const { request, headers } = run(received);

      expect(headers['X-Correlation-Id']).toMatch(UUID);
      expect(correlationIdOf(request)).toBe(headers['X-Correlation-Id'] as string);
    },
  );

  test('makes the id available to everything the request runs', () => {
    expect(run('trace-ctx').contextInsideRequest()).toEqual({ correlationId: 'trace-ctx' });
  });

  test('leaves one access line when the response finishes, with status and duration', () => {
    const lines: { event: string; fields: LogFields | undefined }[] = [];
    const logger: Logger = {
      ...silent,
      info: (event, fields) => {
        lines.push({ event, fields });
      },
    };
    const clock = spyOn(performance, 'now');
    clock.mockReturnValueOnce(1000).mockReturnValueOnce(1250);
    try {
      const { listeners } = run('trace-log', logger);
      listeners.finish?.();
    } finally {
      clock.mockRestore();
    }

    expect(lines).toEqual([
      {
        event: 'http.request',
        fields: {
          correlationId: 'trace-log',
          method: 'POST',
          path: '/wagering/transactions',
          status: 201,
          durationMs: 250,
        },
      },
    ]);
  });
});
