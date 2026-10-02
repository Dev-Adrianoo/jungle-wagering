import { describe, expect, test } from 'bun:test';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import type { Core } from '../../../src/composition/core';
import type { SqsWagerConsumer } from '../../../src/interface/workers/sqs-wager-consumer';
import { Workers } from '../../../src/interface/workers/workers';
import { waitFor } from '../../support/wait-for';

type Line = { level: string; event: string; fields: LogFields };

function recorder() {
  const lines: Line[] = [];
  const record =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      lines.push({ level, event, fields });
    };
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  return { lines, logger };
}

function build(options: { observe?: () => Promise<void>; crashAt?: string } = {}) {
  const { lines, logger } = recorder();
  const published: number[] = [];
  let executions = 0;
  const core = {
    publishOutbox: {
      execute: async () => {
        executions += 1;
        const count = executions === 1 ? 3 : 0;
        published.push(count);
        return count;
      },
      observe: options.observe ?? (async () => {}),
    },
    resolvePendingReferences: { execute: async () => {} },
  } as unknown as Core;
  const consumer = { start: () => {}, stop: async () => {} } as unknown as SqsWagerConsumer;
  const workers = new Workers({ core, consumer, logger, crashAt: options.crashAt });
  return { workers, lines, published, executions: () => executions };
}

describe('Workers', () => {
  test('a failing stats read does not turn a successful publish into an error', async () => {
    const { workers, lines, published, executions } = build({
      observe: async () => {
        throw new Error('stats unavailable');
      },
    });

    workers.start();
    await waitFor(async () => executions() >= 2, {
      description: 'the outbox worker to run again right after publishing',
    });
    await workers.stop();

    expect(published[0]).toBe(3);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
  });

  test('warns at startup when a crash point is armed', () => {
    const { workers, lines } = build({ crashAt: 'consumer.after-commit-before-ack' });

    workers.start();

    expect(lines.filter((line) => line.level === 'warn')).toEqual([
      {
        level: 'warn',
        event: 'workers.fault_injection_armed',
        fields: { crashAt: 'consumer.after-commit-before-ack' },
      },
    ]);
    return workers.stop();
  });

  test('does not warn when no crash point is armed', async () => {
    const { workers, lines } = build();

    workers.start();
    await workers.stop();

    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
  });
});
