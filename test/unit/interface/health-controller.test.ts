import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from '../../../src/interface/http/controllers/health.controller';

const urls = { transactions: 'http://queue/transactions', deadLetter: 'x', events: 'y' };

function controller(options: { postgresUp: boolean; sqsUp: boolean }) {
  const orm = {
    em: {
      fork: () => ({
        getConnection: () => ({
          execute: async () => {
            if (!options.postgresUp) {
              throw new Error('connection refused');
            }
            return [{ '?column?': 1 }];
          },
        }),
      }),
    },
  } as unknown as MikroORM;
  const sqs = {
    send: async () => {
      if (!options.sqsUp) {
        throw new Error('queue unreachable');
      }
      return {};
    },
  } as unknown as SQSClient;
  const statuses: number[] = [];
  const response = { status: (code: number) => statuses.push(code) } as never;
  const ready = () => new HealthController(orm, sqs, urls).ready(response);
  return { ready, statuses };
}

describe('HealthController', () => {
  test('live answers ok without touching any dependency', () => {
    const live = new HealthController(undefined as never, undefined as never, urls).live();

    expect(live).toEqual({ status: 'ok' });
  });

  test('ready is ok with PostgreSQL and SQS up', async () => {
    const { ready, statuses } = controller({ postgresUp: true, sqsUp: true });

    expect(await ready()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
    expect(statuses).toEqual([]);
  });

  test.each([
    ['PostgreSQL', { postgresUp: false, sqsUp: true }, { postgres: 'down', sqs: 'up' }],
    ['SQS', { postgresUp: true, sqsUp: false }, { postgres: 'up', sqs: 'down' }],
    ['both', { postgresUp: false, sqsUp: false }, { postgres: 'down', sqs: 'down' }],
  ])('ready is 503 when %s is down', async (_name, state, checks) => {
    const { ready, statuses } = controller(state);

    expect(await ready()).toEqual({ status: 'unavailable', checks });
    expect(statuses).toEqual([503]);
  });
});
