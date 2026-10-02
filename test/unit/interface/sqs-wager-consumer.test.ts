import { afterEach, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { CrashPoint } from '../../../src/application/ports/crash-point';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import type { Metrics } from '../../../src/application/ports/metrics';
import { SqsWagerConsumer } from '../../../src/interface/workers/sqs-wager-consumer';
import type {
  Disposition,
  WagerMessageHandler,
} from '../../../src/interface/workers/wager-message-handler';
import { waitFor } from '../../support/wait-for';

const urls = {
  transactions: 'http://queue/transactions',
  deadLetter: 'http://queue/dead-letter',
  events: 'http://queue/events',
};

interface Sent {
  kind: 'receive' | 'delete' | 'visibility' | 'dead-letter';
  input: Record<string, unknown>;
}

function message(id: string, attributes: Record<string, string> = {}, body = `{"id":"${id}"}`) {
  return {
    MessageId: `sqs-${id}`,
    ReceiptHandle: `receipt-${id}`,
    Body: body,
    Attributes: { MessageGroupId: 'wallet-1', ApproximateReceiveCount: '1', ...attributes },
  } as Message;
}

class Harness {
  sent: Sent[] = [];
  handled: string[] = [];
  events: string[] = [];
  retried = 0;
  deadLettered: string[] = [];
  logs: { level: string; event: string; fields: LogFields | undefined }[] = [];
  crashPoints: string[] = [];
  consumer: SqsWagerConsumer | undefined;
  private batches: Message[][];
  receiveGate: Promise<void> | undefined;
  receiveFailures = 0;
  receiveTimes: number[] = [];
  inFlightReceives = 0;
  maxInFlightReceives = 0;

  constructor(
    batches: Message[][],
    private readonly dispositions: (body: string) => Disposition | Error,
    private readonly options = {
      waitTimeSeconds: 7,
      batchSize: 4,
      baseBackoffSeconds: 2,
      maxBackoffSeconds: 5,
    },
  ) {
    this.batches = [...batches];
  }

  private client = {
    send: async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        this.sent.push({ kind: 'receive', input: { ...command.input } });
        this.receiveTimes.push(Date.now());
        this.inFlightReceives += 1;
        this.maxInFlightReceives = Math.max(this.maxInFlightReceives, this.inFlightReceives);
        try {
          await this.receiveGate;
          if (this.receiveFailures > 0) {
            this.receiveFailures -= 1;
            throw new Error('queue unreachable');
          }
          const next = this.batches.shift();
          if (!next) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return { Messages: next ?? [] };
        } finally {
          this.inFlightReceives -= 1;
        }
      }
      if (command instanceof DeleteMessageCommand) {
        this.sent.push({ kind: 'delete', input: { ...command.input } });
        this.events.push('delete');
        return {};
      }
      if (command instanceof ChangeMessageVisibilityCommand) {
        this.sent.push({ kind: 'visibility', input: { ...command.input } });
        return {};
      }
      if (command instanceof SendMessageCommand) {
        this.sent.push({ kind: 'dead-letter', input: { ...command.input } });
        this.events.push('dead-letter');
        return {};
      }
      throw new Error('unexpected command');
    },
  } as unknown as SQSClient;

  private handler = {
    handle: async (body: string) => {
      this.handled.push(body);
      this.events.push('handled');
      const outcome = this.dispositions(body);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
  } as unknown as WagerMessageHandler;

  start() {
    const metrics = {
      messageRetried: () => {
        this.retried += 1;
      },
      messageDeadLettered: (reason: string) => {
        this.deadLettered.push(reason);
      },
    } as unknown as Metrics;
    const at =
      (level: string) =>
      (event: string, fields?: LogFields): void => {
        this.logs.push({ level, event, fields });
      };
    const logger: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
    const crashPoint: CrashPoint = {
      reached: (point) => {
        this.crashPoints.push(point);
        this.events.push('crash-point');
      },
    };
    this.consumer = new SqsWagerConsumer({
      client: this.client,
      urls,
      handler: this.handler,
      metrics,
      logger,
      crashPoint,
      options: this.options,
    });
    this.consumer.start();
    return this.consumer;
  }

  of(kind: Sent['kind']) {
    return this.sent.filter((entry) => entry.kind === kind).map((entry) => entry.input);
  }

  drained() {
    return waitFor(async () => this.batches.length === 0 && this.inFlightReceives <= 1, {
      description: 'the scripted batches to be consumed',
      intervalMs: 10,
    });
  }

  async settle() {
    await this.drained();
    await this.consumer?.stop();
  }
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.consumer?.stop();
  harness = undefined;
});

const ack: Disposition = { action: 'ack', outcome: 'processed' };

describe('SqsWagerConsumer receiving', () => {
  test('asks for batches with the configured size and wait, plus the group and receive count', async () => {
    harness = new Harness([[]], () => ack);
    harness.start();
    await waitFor(async () => (harness?.of('receive').length ?? 0) > 0, { intervalMs: 5 });
    await harness.settle();

    expect(harness.of('receive')[0]).toEqual({
      QueueUrl: urls.transactions,
      MaxNumberOfMessages: 4,
      WaitTimeSeconds: 7,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    });
  });

  test('a receive failure is logged and polling resumes after a pause', async () => {
    harness = new Harness([[]], () => ack);
    harness.receiveFailures = 1;
    harness.start();
    await waitFor(async () => (harness?.receiveTimes.length ?? 0) >= 2, {
      description: 'a second receive after the failure',
      intervalMs: 20,
    });

    const [first = 0, second = 0] = harness.receiveTimes;
    expect(second - first).toBeGreaterThanOrEqual(900);
    expect(harness.logs[0]).toEqual({
      level: 'error',
      event: 'sqs.receive_failed',
      fields: { error: 'Error' },
    });
  });

  test('start() twice still runs one polling loop', async () => {
    let release: () => void = () => {};
    harness = new Harness([], () => ack);
    harness.receiveGate = new Promise((resolve) => {
      release = resolve;
    });
    harness.start();
    harness.consumer?.start();
    await waitFor(async () => (harness?.inFlightReceives ?? 0) > 0, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.maxInFlightReceives).toBe(1);
    release();
  });
});

describe('SqsWagerConsumer dispositions', () => {
  test('an ack deletes the message from the transactions queue after the crash point', async () => {
    harness = new Harness([[message('a')]], () => ack);
    harness.start();
    await harness.settle();

    expect(harness.of('delete')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-a' },
    ]);
    expect(harness.of('dead-letter')).toHaveLength(0);
    expect(harness.events).toEqual(['handled', 'crash-point', 'delete']);
    expect(harness.crashPoints).toEqual(['consumer.after-commit-before-ack']);
  });

  test('a dead-letter copies the message with its reason, then deletes the original', async () => {
    harness = new Harness([[message('a', {}, '{"raw":"body"}')]], () => ({
      action: 'dead-letter',
      reason: 'WALLET_NOT_FOUND',
    }));
    harness.start();
    await harness.settle();

    expect(harness.of('dead-letter')).toEqual([
      {
        QueueUrl: urls.deadLetter,
        MessageBody: '{"raw":"body"}',
        MessageGroupId: 'wallet-1',
        MessageDeduplicationId: 'sqs-a',
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: 'WALLET_NOT_FOUND' },
          originalMessageId: { DataType: 'String', StringValue: 'sqs-a' },
        },
      },
    ]);
    expect(harness.of('delete')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-a' },
    ]);
    expect(harness.events).toEqual(['handled', 'crash-point', 'dead-letter', 'delete']);
    expect(harness.deadLettered).toEqual(['WALLET_NOT_FOUND']);
    expect(harness.logs).toEqual([
      {
        level: 'warn',
        event: 'sqs.dead_lettered',
        fields: { reason: 'WALLET_NOT_FOUND', sqsMessageId: 'sqs-a' },
      },
    ]);
  });

  test('a message without a group is dead-lettered into the dead-letter group', async () => {
    const ungrouped = { ...message('a'), Attributes: { ApproximateReceiveCount: '1' } } as Message;
    harness = new Harness([[ungrouped]], () => ({ action: 'dead-letter', reason: 'X' }));
    harness.start();
    await harness.settle();

    expect(harness.of('dead-letter')[0]?.MessageGroupId).toBe('dead-letter');
  });

  test('a retry hides the message for an exponential backoff and counts the retry', async () => {
    harness = new Harness(
      [
        [message('a', { ApproximateReceiveCount: '1' })],
        [message('b', { ApproximateReceiveCount: '2' })],
        [message('c', { ApproximateReceiveCount: '3' })],
        [message('d', { ApproximateReceiveCount: '4' })],
      ],
      () => ({ action: 'retry' }),
    );
    harness.start();
    await harness.settle();

    expect(harness.of('visibility')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-a', VisibilityTimeout: 2 },
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-b', VisibilityTimeout: 4 },
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-c', VisibilityTimeout: 5 },
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-d', VisibilityTimeout: 5 },
    ]);
    expect(harness.retried).toBe(4);
    expect(harness.of('delete')).toHaveLength(0);
  });

  test('a message without a receive count is treated as the first attempt', async () => {
    const bare = { ...message('a'), Attributes: { MessageGroupId: 'g' } } as Message;
    harness = new Harness([[bare]], () => ({ action: 'retry' }));
    harness.start();
    await harness.settle();

    expect(harness.of('visibility')[0]?.VisibilityTimeout).toBe(2);
  });

  test('a retry on the fifth receive is dead-lettered as exhausted, the fourth is not', async () => {
    harness = new Harness(
      [
        [message('a', { ApproximateReceiveCount: '4' })],
        [message('b', { ApproximateReceiveCount: '5' })],
      ],
      () => ({ action: 'retry' }),
    );
    harness.start();
    await harness.settle();

    expect(harness.of('visibility')).toHaveLength(1);
    expect(harness.deadLettered).toEqual(['RETRIES_EXHAUSTED']);
    expect(harness.of('dead-letter')[0]?.MessageDeduplicationId).toBe('sqs-b');
  });
});

describe('SqsWagerConsumer ordering within a batch', () => {
  const body = (text: string) => `{"id":"${text}"}`;

  test('after a retry the later messages of the same group are released untouched', async () => {
    harness = new Harness(
      [
        [
          message('a1', { MessageGroupId: 'g1' }),
          message('a2', { MessageGroupId: 'g1' }),
          message('b1', { MessageGroupId: 'g2' }),
        ],
      ],
      (text) => (text === body('a1') ? { action: 'retry' } : ack),
    );
    harness.start();
    await harness.settle();

    expect(harness.handled).toEqual([body('a1'), body('b1')]);
    expect(harness.of('visibility')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-a1', VisibilityTimeout: 2 },
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-a2', VisibilityTimeout: 2 },
    ]);
    expect(harness.of('delete')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-b1' },
    ]);
  });

  test('a handler crash blocks its group the same way and is logged without the message', async () => {
    harness = new Harness(
      [
        [
          message('a1', { MessageGroupId: 'g1', ApproximateReceiveCount: '2' }),
          message('a2', { MessageGroupId: 'g1' }),
        ],
      ],
      (text) => (text === body('a1') ? new Error('password=hunter2') : ack),
    );
    harness.start();
    await harness.settle();

    expect(harness.handled).toEqual([body('a1')]);
    expect(harness.of('visibility')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-a2', VisibilityTimeout: 4 },
    ]);
    expect(harness.logs).toEqual([
      {
        level: 'error',
        event: 'sqs.message_failed',
        fields: { sqsMessageId: 'sqs-a1', error: 'Error' },
      },
    ]);
  });

  test('messages without a group id are not mistaken for one big group', async () => {
    const ungrouped = (id: string) =>
      ({ ...message(id), Attributes: { ApproximateReceiveCount: '1' } }) as Message;
    harness = new Harness([[ungrouped('x'), ungrouped('y')]], (text) =>
      text === body('x') ? { action: 'retry' } : ack,
    );
    harness.start();
    await harness.settle();

    expect(harness.handled).toEqual([body('x')]);
  });

  test('once stop() is requested the rest of the batch is released immediately', async () => {
    harness = new Harness(
      [[message('a', { MessageGroupId: 'g1' }), message('b', { MessageGroupId: 'g2' })]],
      () => {
        void harness?.consumer?.stop();
        return ack;
      },
    );
    harness.start();
    await waitFor(async () => (harness?.of('visibility').length ?? 0) > 0, {
      description: 'the second message to be released',
      intervalMs: 5,
    });

    expect(harness.handled).toEqual([body('a')]);
    expect(harness.of('visibility')).toEqual([
      { QueueUrl: urls.transactions, ReceiptHandle: 'receipt-b', VisibilityTimeout: 0 },
    ]);
  });
});
