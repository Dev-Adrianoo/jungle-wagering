import { describe, expect, test } from 'bun:test';
import type { CrashPoint } from '../../../src/application/ports/crash-point';
import { EnvCrashPoint } from '../../../src/infrastructure/system/env-crash-point';
import { NoopCrashPoint } from '../../../src/infrastructure/system/noop-crash-point';

function crashPoint(configured: string | undefined) {
  const exits: number[] = [];
  const point = new EnvCrashPoint(configured, ((code: number) => {
    exits.push(code);
  }) as never);
  return { point, exits };
}

describe('EnvCrashPoint', () => {
  test('kills the process with 137 at the configured point', () => {
    const { point, exits } = crashPoint('consumer.after-commit-before-ack');

    point.reached('consumer.after-commit-before-ack');

    expect(exits).toEqual([137]);
  });

  test('ignores every other point', () => {
    const { point, exits } = crashPoint('consumer.after-commit-before-ack');

    point.reached('publisher.after-send-before-mark');

    expect(exits).toEqual([]);
  });

  test('does nothing when no point is configured', () => {
    const { point, exits } = crashPoint(undefined);

    point.reached('undefined');
    point.reached('consumer.after-commit-before-ack');

    expect(exits).toEqual([]);
  });

  test('the no-op crash point never exits', () => {
    const point: CrashPoint = new NoopCrashPoint();

    expect(() => point.reached('consumer.after-commit-before-ack')).not.toThrow();
  });
});
