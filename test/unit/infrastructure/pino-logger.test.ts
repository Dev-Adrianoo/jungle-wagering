import { describe, expect, test } from 'bun:test';
import {
  addLogContext,
  runWithLogContext,
} from '../../../src/infrastructure/observability/log-context';
import { PinoLogger } from '../../../src/infrastructure/observability/pino-logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = new PinoLogger('info', {
    write: (line: string) => {
      lines.push(JSON.parse(line));
    },
  });
  return { lines, logger };
}

describe('PinoLogger', () => {
  test('writes one JSON object per line with the event name and level', () => {
    const { lines, logger } = capture();

    logger.info('wager.processed', { transactionId: 'tx-1' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'wager.processed',
      transactionId: 'tx-1',
    });
    expect(typeof lines[0]?.time).toBe('string');
  });

  test('merges the fields of the surrounding log context', () => {
    const { lines, logger } = capture();

    runWithLogContext({ correlationId: 'corr-1', messageId: 'msg-1' }, () => {
      addLogContext({ walletId: 'w-1', providerId: 'provider-a' });
      logger.warn('wager.rejected', { transactionId: 'tx-1' });
    });

    expect(lines[0]).toMatchObject({
      level: 'warn',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      walletId: 'w-1',
      providerId: 'provider-a',
      transactionId: 'tx-1',
    });
  });

  test('contexts do not leak between concurrent executions', async () => {
    const { lines, logger } = capture();

    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithLogContext({ correlationId: id }, async () => {
          await Promise.resolve();
          logger.info('tick', {});
        }),
      ),
    );

    expect(lines.map((line) => line.correlationId).sort()).toEqual(['a', 'b', 'c']);
  });

  test('omits undefined fields and respects the level', () => {
    const { lines, logger } = capture();
    const quiet = new PinoLogger('error', { write: (line) => lines.push(JSON.parse(line)) });

    logger.info('x', { walletId: undefined });
    quiet.info('hidden', {});

    expect(lines).toHaveLength(1);
    expect('walletId' in (lines[0] as object)).toBe(false);
  });
});
