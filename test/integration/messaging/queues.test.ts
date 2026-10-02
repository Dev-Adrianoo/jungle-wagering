import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  ensureQueues,
  MAX_RECEIVE_COUNT,
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

  test('the transactions queue redrives to the dead-letter queue after the receive limit', async () => {
    const transactions = await attributesOf(queues.urls.transactions);
    const deadLetter = await attributesOf(queues.urls.deadLetter);

    expect(JSON.parse(transactions.RedrivePolicy ?? '{}')).toEqual({
      deadLetterTargetArn: deadLetter.QueueArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    });
  });

  test('is idempotent', async () => {
    expect(await ensureQueues(queues.client, queues.config)).toEqual(queues.urls);
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
