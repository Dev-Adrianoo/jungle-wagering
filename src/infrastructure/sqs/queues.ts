// The consumer counts attempts itself (MAX_RECEIVE_COUNT) and dead-letters with a reason.
// Releasing a message untouched still counts as a receive for SQS, so the native redrive uses a
// higher limit and only catches messages the consumer could not dead-letter itself.
// CreateQueue fails when an existing queue has other attributes, so they are applied afterwards.
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../config/config';

export interface QueueUrls {
  transactions: string;
  deadLetter: string;
  events: string;
}

export const MAX_RECEIVE_COUNT = 5;
export const REDRIVE_BACKSTOP_RECEIVE_COUNT = 15;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;

async function createFifoQueue(client: SQSClient, name: string): Promise<string> {
  const created = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  if (!created.QueueUrl) {
    throw new Error(`SQS did not return a URL for queue ${name}`);
  }
  return created.QueueUrl;
}

async function arnOf(client: SQSClient, queueUrl: string): Promise<string> {
  const response = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = response.Attributes?.QueueArn;
  if (!arn) {
    throw new Error(`SQS did not return an ARN for ${queueUrl}`);
  }
  return arn;
}

export async function ensureQueues(
  client: SQSClient,
  config: SqsConfig,
  options: { visibilityTimeoutSeconds?: number } = {},
): Promise<QueueUrls> {
  const visibility = String(options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS);
  const deadLetter = await createFifoQueue(client, config.deadLetterQueue);
  const events = await createFifoQueue(client, config.eventsQueue);
  const transactionsAttributes = {
    VisibilityTimeout: visibility,
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: await arnOf(client, deadLetter),
      maxReceiveCount: REDRIVE_BACKSTOP_RECEIVE_COUNT,
    }),
  };
  const transactions = await createFifoQueue(client, config.transactionsQueue);
  await client.send(
    new SetQueueAttributesCommand({ QueueUrl: transactions, Attributes: transactionsAttributes }),
  );
  return { transactions, deadLetter, events };
}

async function urlOf(client: SQSClient, name: string): Promise<string> {
  const response = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!response.QueueUrl) {
    throw new Error(`queue ${name} does not exist`);
  }
  return response.QueueUrl;
}

export async function resolveQueueUrls(client: SQSClient, config: SqsConfig): Promise<QueueUrls> {
  return {
    transactions: await urlOf(client, config.transactionsQueue),
    deadLetter: await urlOf(client, config.deadLetterQueue),
    events: await urlOf(client, config.eventsQueue),
  };
}
