import { describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { TransientInfrastructureError } from '../../../src/application/errors';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import { ProblemDetailsFilter } from '../../../src/interface/http/problem-details.filter';

interface Entry {
  level: string;
  event: string;
  fields: LogFields;
}

function recorder() {
  const entries: Entry[] = [];
  const at =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      entries.push({ level, event, fields });
    };
  const logger: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { entries, logger };
}

function hostFor() {
  const response = {
    setHeader() {},
    status() {
      return this;
    },
    type() {
      return this;
    },
    send() {},
  };
  const request = { correlationId: 'corr-filter' };
  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
}

describe('ProblemDetailsFilter logging', () => {
  test('a 500 is logged as an error with the name and code, never the message', () => {
    const { entries, logger } = recorder();
    const failure = Object.assign(new Error('password=hunter2 host=db.internal'), {
      code: 'XX000',
    });

    new ProblemDetailsFilter(logger).catch(failure, hostFor());

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      event: 'http.unhandled_error',
      fields: { correlationId: 'corr-filter', error: 'Error', code: 'XX000' },
    });
    expect(JSON.stringify(entries)).not.toContain('hunter2');
  });

  test('a 503 is a warning under http.transient_failure, never the message', () => {
    const { entries, logger } = recorder();
    const failure = new TransientInfrastructureError('password=hunter2 host=db.internal');

    new ProblemDetailsFilter(logger).catch(failure, hostFor());

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'warn',
      event: 'http.transient_failure',
      fields: {
        correlationId: 'corr-filter',
        error: 'TransientInfrastructureError',
        code: 'SERVICE_UNAVAILABLE',
      },
    });
    expect(JSON.stringify(entries)).not.toContain('hunter2');
  });
});
