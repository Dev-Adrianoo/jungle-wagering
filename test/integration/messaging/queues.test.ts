import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  ensureQueues,
  REDRIVE_BACKSTOP_RECEIVE_COUNT,
  resolveQueueUrls,
} from '../../../src/infrastructure/sqs/queues';
import { rejectionOf } from '../../support/rejection';
import { createTestQueues, type TestQueues } from '../../support/sqs';

let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues();
});

afterAll(async () => {
  await queues.destroy();
});

const attributesOf = async (queueUrl: string) =>
  (
    await queues.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
    )
  ).Attributes ?? {};

describe('ensureQueues', () => {
  test('creates three FIFO queues', async () => {
    for (const url of [queues.urls.transactions, queues.urls.deadLetter, queues.urls.events]) {
      expect((await attributesOf(url)).FifoQueue).toBe('true');
    }
  });

  test('the transactions queue redrives to the dead-letter queue only as a backstop', async () => {
    const transactions = await attributesOf(queues.urls.transactions);
    const deadLetter = await attributesOf(queues.urls.deadLetter);

    expect(JSON.parse(transactions.RedrivePolicy ?? '{}')).toEqual({
      deadLetterTargetArn: deadLetter.QueueArn,
      maxReceiveCount: REDRIVE_BACKSTOP_RECEIVE_COUNT,
    });
  });

  test('is idempotent', async () => {
    expect(await ensureQueues(queues.client, queues.config)).toEqual(queues.urls);
  });

  test('re-running updates the redrive policy of an existing queue', async () => {
    const deadLetter = await attributesOf(queues.urls.deadLetter);
    await queues.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: queues.urls.transactions,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: deadLetter.QueueArn,
            maxReceiveCount: 5,
          }),
        },
      }),
    );

    await ensureQueues(queues.client, queues.config);

    const policy = JSON.parse((await attributesOf(queues.urls.transactions)).RedrivePolicy ?? '{}');
    expect(policy.maxReceiveCount).toBe(REDRIVE_BACKSTOP_RECEIVE_COUNT);
  });

  test('resolveQueueUrls finds the same queues without creating anything', async () => {
    expect(await resolveQueueUrls(queues.client, queues.config)).toEqual(queues.urls);
  });

  test('resolveQueueUrls fails for a queue that does not exist', async () => {
    const missing = { ...queues.config, eventsQueue: 'never-created.fifo' };
    expect(await rejectionOf(resolveQueueUrls(queues.client, missing))).toBeInstanceOf(Error);
  });
});

describe('the test queue helper', () => {
  test('sends to the transactions queue and reads it back', async () => {
    await queues.send({ hello: 'world' });

    const received = await queues.receiveAll(queues.urls.transactions);

    expect(received.map((message) => JSON.parse(message.body))).toEqual([{ hello: 'world' }]);
    expect(await queues.depth(queues.urls.transactions)).toBe(0);
  });
});
