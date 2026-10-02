import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../config/config';

export interface QueueUrls {
  transactions: string;
  deadLetter: string;
  events: string;
}

export const MAX_RECEIVE_COUNT = 5;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;

async function createFifoQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const created = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
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
  const deadLetter = await createFifoQueue(client, config.deadLetterQueue, {});
  const events = await createFifoQueue(client, config.eventsQueue, {});
  const transactions = await createFifoQueue(client, config.transactionsQueue, {
    VisibilityTimeout: visibility,
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: await arnOf(client, deadLetter),
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  });
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
