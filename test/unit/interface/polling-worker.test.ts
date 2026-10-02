import { describe, expect, test } from 'bun:test';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import { PollingWorker } from '../../../src/interface/workers/polling-worker';
import { waitFor } from '../../support/wait-for';

function recorder() {
  const errors: Array<{ event: string; fields: LogFields }> = [];
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: (event, fields = {}) => {
      errors.push({ event, fields });
    },
  };
  return { errors, logger };
}

describe('PollingWorker', () => {
  test('keeps ticking until it is stopped', async () => {
    let ticks = 0;
    const worker = new PollingWorker(
      'test',
      5,
      async () => {
        ticks += 1;
        return 0;
      },
      recorder().logger,
    );

    worker.start();
    await waitFor(async () => ticks >= 3, { description: 'three ticks' });
    await worker.stop();
    const afterStop = ticks;
    await waitFor(async () => true);

    expect(ticks).toBe(afterStop);
  });

  test('runs again immediately while there is work, without the idle delay', async () => {
    let remaining = 5;
    const worker = new PollingWorker(
      'test',
      60_000,
      async () => {
        if (remaining === 0) {
          return 0;
        }
        remaining -= 1;
        return 1;
      },
      recorder().logger,
    );

    worker.start();
    await waitFor(async () => remaining === 0, {
      timeoutMs: 2_000,
      description: 'five busy ticks',
    });
    await worker.stop();

    expect(remaining).toBe(0);
  });

  test('stop() waits for the tick in flight', async () => {
    let finished = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const tickStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new PollingWorker(
      'test',
      5,
      async () => {
        started();
        await gate;
        finished = true;
        return 0;
      },
      recorder().logger,
    );

    worker.start();
    await tickStarted;
    const stopping = worker.stop();
    release();
    await stopping;

    expect(finished).toBe(true);
  });

  test('a failing tick is logged and does not end the loop', async () => {
    const { errors, logger } = recorder();
    let ticks = 0;
    const worker = new PollingWorker(
      'outbox',
      5,
      async () => {
        ticks += 1;
        if (ticks === 1) {
          throw new Error('first tick fails');
        }
        return 0;
      },
      logger,
    );

    worker.start();
    await waitFor(async () => ticks >= 3, { description: 'ticks after the failure' });
    await worker.stop();

    expect(errors[0]).toMatchObject({ event: 'worker.tick_failed', fields: { worker: 'outbox' } });
  });

  test('a logger that throws does not end the loop either', async () => {
    let ticks = 0;
    const throwingLogger: Logger = {
      info: () => {},
      warn: () => {},
      error: () => {
        throw new Error('logger down');
      },
    };
    const worker = new PollingWorker(
      'test',
      5,
      async () => {
        ticks += 1;
        throw new Error('tick fails');
      },
      throwingLogger,
    );

    worker.start();
    await waitFor(async () => ticks >= 3, { description: 'ticks despite the logger' });
    await worker.stop();

    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  test('stop() interrupts a long idle delay', async () => {
    let ticks = 0;
    const worker = new PollingWorker(
      'test',
      60_000,
      async () => {
        ticks += 1;
        return 0;
      },
      recorder().logger,
    );
    worker.start();
    await waitFor(async () => ticks >= 1, { description: 'the first tick' });
    const startedAt = Date.now();

    await worker.stop();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test('stop() before start() is harmless', async () => {
    const worker = new PollingWorker('test', 5, async () => 0, recorder().logger);

    await worker.stop();
  });
});
