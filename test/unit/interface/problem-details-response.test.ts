import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { TransientInfrastructureError, WalletNotFoundError } from '../../../src/application/errors';
import { SilentLogger } from '../../../src/infrastructure/observability/silent-logger';
import { ProblemDetailsFilter } from '../../../src/interface/http/problem-details.filter';

function respondTo(exception: unknown, request: object = { correlationId: 'corr-1' }) {
  const headers: Record<string, string> = {};
  const sent: { status?: number; type?: string; body?: Record<string, unknown> } = {};
  const response = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    type(value: string) {
      sent.type = value;
      return this;
    },
    send(payload: string) {
      sent.body = JSON.parse(payload);
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter(new SilentLogger()).catch(exception, host);
  return { headers, sent };
}

describe('ProblemDetailsFilter response', () => {
  test('a 503 tells the caller when to retry', () => {
    const { headers, sent } = respondTo(new TransientInfrastructureError('down'));

    expect(sent.status).toBe(503);
    expect(headers['Retry-After']).toBe('1');
  });

  test.each([
    ['a 404', new WalletNotFoundError('w')],
    ['a 500', new Error('boom')],
  ])('%s carries no Retry-After', (_name, exception) => {
    expect(respondTo(exception).headers['Retry-After']).toBeUndefined();
  });

  test('is served as problem+json with the correlation id of the request', () => {
    const { sent } = respondTo(new WalletNotFoundError('w'));

    expect(sent.type).toBe('application/problem+json');
    expect(sent.body?.correlationId).toBe('corr-1');
  });

  test('a request that never went through the correlation middleware is reported as unknown', () => {
    expect(respondTo(new WalletNotFoundError('w'), {}).sent.body?.correlationId).toBe('unknown');
  });
});
