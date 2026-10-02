import { describe, expect, test } from 'bun:test';
import {
  IdempotencyKeyConflictError,
  TransientInfrastructureError,
} from '../../../src/application/errors';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import type {
  InboxEnvelope,
  MessageOutcome,
  SubmitWagerCommand,
} from '../../../src/application/use-cases/submit-wager-transaction';
import { currentLogContext } from '../../../src/infrastructure/observability/log-context';
import { parseWagerMessage } from '../../../src/interface/contracts/wager-message.schema';
import { WagerMessageHandler } from '../../../src/interface/workers/wager-message-handler';

const body = JSON.stringify({
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  correlationId: 'trace-from-provider',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});

interface Entry {
  level: string;
  event: string;
  fields: LogFields;
}

function recordingLogger() {
  const entries: Entry[] = [];
  const at =
    (level: string) =>
    (event: string, fields: LogFields = {}) => {
      entries.push({ level, event, fields });
    };
  const logger: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { entries, logger };
}

function handlerThat(behaviour: () => Promise<MessageOutcome>, logger: Logger) {
  const seen: {
    command?: SubmitWagerCommand;
    inbox?: InboxEnvelope;
    context?: LogFields;
  } = {};
  const handler = new WagerMessageHandler(
    {
      executeFromMessage: async (command, inbox) => {
        seen.command = command;
        seen.inbox = inbox;
        seen.context = { ...currentLogContext() };
        return behaviour();
      },
    },
    logger,
  );
  return { handler, seen };
}

const duplicate = async (): Promise<MessageOutcome> => ({ duplicate: true });

describe('WagerMessageHandler forwarding', () => {
  test('hands the use case the envelope identity, the caller correlation id and the message hash', async () => {
    const { logger } = recordingLogger();
    const { handler, seen } = handlerThat(duplicate, logger);

    await handler.handle(body);

    expect(seen.command?.correlationId).toBe('trace-from-provider');
    expect(seen.inbox).toEqual({
      consumerName: 'wager-transaction-consumer',
      messageId: 'msg-1',
      payloadHash: parseWagerMessage(body).payloadHash,
    });
  });

  test('runs the use case inside a log context carrying the correlation and message ids', async () => {
    const { logger } = recordingLogger();
    const { handler, seen } = handlerThat(duplicate, logger);

    await handler.handle(body);

    expect(seen.context).toMatchObject({
      correlationId: 'trace-from-provider',
      messageId: 'msg-1',
    });
  });
});

describe('WagerMessageHandler logging', () => {
  test('an invalid message is a warning that does not echo the body', async () => {
    const { entries, logger } = recordingLogger();
    const { handler } = handlerThat(duplicate, logger);

    await handler.handle('{"secret": "card-number"');

    expect(entries).toEqual([{ level: 'warn', event: 'sqs.invalid_message', fields: {} }]);
  });

  test('a transient failure is a warning with its code', async () => {
    const { entries, logger } = recordingLogger();
    const { handler } = handlerThat(async () => {
      throw new TransientInfrastructureError('db down at 10.0.0.5');
    }, logger);

    await handler.handle(body);

    expect(entries).toEqual([
      { level: 'warn', event: 'sqs.transient_failure', fields: { code: 'SERVICE_UNAVAILABLE' } },
    ]);
  });

  test('a permanent failure is a warning with its code', async () => {
    const { entries, logger } = recordingLogger();
    const { handler } = handlerThat(async () => {
      throw new IdempotencyKeyConflictError('provider-a:ext-1');
    }, logger);

    await handler.handle(body);

    expect(entries).toEqual([
      {
        level: 'warn',
        event: 'sqs.permanent_failure',
        fields: { code: 'IDEMPOTENCY_KEY_CONFLICT' },
      },
    ]);
  });

  test('an unexpected failure is an error with the error name, never its message', async () => {
    const { entries, logger } = recordingLogger();
    const { handler } = handlerThat(async () => {
      throw new Error('password=hunter2');
    }, logger);

    await handler.handle(body);

    expect(entries).toEqual([
      { level: 'error', event: 'sqs.unexpected_failure', fields: { error: 'Error' } },
    ]);
  });
});
