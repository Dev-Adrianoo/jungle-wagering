import { describe, expect, test } from 'bun:test';
import {
  DuplicateExternalTransactionError,
  IdempotencyKeyConflictError,
  MessageIdReusedError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import type { MessageOutcome } from '../../../src/application/use-cases/submit-wager-transaction';
import { InvalidMoneyError } from '../../../src/domain/money/money';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction';
import { SilentLogger } from '../../../src/infrastructure/observability/silent-logger';
import { WagerMessageHandler } from '../../../src/interface/workers/wager-message-handler';

const body = JSON.stringify({
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
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

const processed = {
  duplicate: false,
  result: {
    transactionId: 'tx-1',
    status: WagerTransactionStatus.Processed,
    balance: { amount: '75.00', currency: 'BRL' },
    idempotentReplay: false,
  },
} as unknown as MessageOutcome;

function handlerThat(behaviour: () => Promise<MessageOutcome>) {
  const calls: unknown[] = [];
  const handler = new WagerMessageHandler(
    {
      executeFromMessage: async (command, inbox) => {
        calls.push({ command, inbox });
        return behaviour();
      },
    },
    new SilentLogger(),
  );
  return { handler, calls };
}

describe('WagerMessageHandler', () => {
  test('acks a processed message and passes the envelope to the use case', async () => {
    const { handler, calls } = handlerThat(async () => processed);

    expect(await handler.handle(body)).toEqual({ action: 'ack', outcome: 'processed' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: { idempotencyKey: 'provider-a:ext-1', source: 'sqs', correlationId: 'msg-1' },
      inbox: { consumerName: 'wager-transaction-consumer', messageId: 'msg-1' },
    });
  });

  test('acks a business rejection: it is a final answer, not a failure', async () => {
    const rejected = {
      duplicate: false,
      result: {
        ...(processed as { result: object }).result,
        status: WagerTransactionStatus.Rejected,
      },
    } as unknown as MessageOutcome;
    const { handler } = handlerThat(async () => rejected);

    expect(await handler.handle(body)).toEqual({ action: 'ack', outcome: 'processed' });
  });

  test('acks a duplicate', async () => {
    const { handler } = handlerThat(async () => ({ duplicate: true }));
    expect(await handler.handle(body)).toEqual({ action: 'ack', outcome: 'duplicate' });
  });

  test('dead-letters an invalid message without calling the use case', async () => {
    const { handler, calls } = handlerThat(async () => processed);

    expect(await handler.handle('not json')).toEqual({
      action: 'dead-letter',
      reason: 'INVALID_MESSAGE',
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['an idempotency conflict', new IdempotencyKeyConflictError('k'), 'IDEMPOTENCY_KEY_CONFLICT'],
    [
      'a duplicate external transaction',
      new DuplicateExternalTransactionError('p', 'e'),
      'DUPLICATE_EXTERNAL_TRANSACTION',
    ],
    ['an unknown wallet', new WalletNotFoundError('w'), 'WALLET_NOT_FOUND'],
    ['a reused message id', new MessageIdReusedError('m'), 'MESSAGE_ID_REUSED'],
    ['a domain error', new InvalidMoneyError('bad'), 'INVALID_MONEY'],
  ])('dead-letters %s', async (_name, error, reason) => {
    const { handler } = handlerThat(async () => {
      throw error;
    });
    expect(await handler.handle(body)).toEqual({ action: 'dead-letter', reason });
  });

  test.each([
    ['a transient infrastructure failure', new TransientInfrastructureError('db down')],
    ['an unknown error', new Error('boom')],
  ])('retries %s', async (_name, error) => {
    const { handler } = handlerThat(async () => {
      throw error;
    });
    expect(await handler.handle(body)).toEqual({ action: 'retry' });
  });
});
