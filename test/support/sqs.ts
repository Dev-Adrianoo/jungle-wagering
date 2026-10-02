import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../src/config/config';
import { ensureQueues, type QueueUrls } from '../../src/infrastructure/sqs/queues';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';

export interface ReceivedMessage {
  body: string;
  attributes: Record<string, string>;
}

export interface TestQueues {
  client: SQSClient;
  config: SqsConfig;
  urls: QueueUrls;
  send(body: unknown, options?: { groupId?: string; deduplicationId?: string }): Promise<void>;
  receiveAll(queueUrl: string, options?: { waitSeconds?: number }): Promise<ReceivedMessage[]>;
  depth(queueUrl: string): Promise<number>;
  destroy(): Promise<void>;
}

export async function createTestQueues(
  options: { visibilityTimeoutSeconds?: number } = {},
): Promise<TestQueues> {
  const prefix = `t${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const config: SqsConfig = {
    endpoint: process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566',
    region: 'us-east-1',
    transactionsQueue: `${prefix}-wager-transactions.fifo`,
    deadLetterQueue: `${prefix}-wager-transactions-dlq.fifo`,
    eventsQueue: `${prefix}-wager-events.fifo`,
  };
  const client = createSqsClient(config);
  const urls = await ensureQueues(client, config, options);

  return {
    client,
    config,
    urls,
    send: async (body, sendOptions = {}) => {
      await client.send(
        new SendMessageCommand({
          QueueUrl: urls.transactions,
          MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
          MessageGroupId: sendOptions.groupId ?? 'test-group',
          MessageDeduplicationId: sendOptions.deduplicationId ?? randomUUID(),
        }),
      );
    },
    receiveAll: async (queueUrl, receiveOptions = {}) => {
      const received: ReceivedMessage[] = [];
      for (;;) {
        const batch = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: receiveOptions.waitSeconds ?? 1,
            MessageAttributeNames: ['All'],
          }),
        );
        const messages = batch.Messages ?? [];
        if (messages.length === 0) {
          return received;
        }
        for (const message of messages) {
          received.push({
            body: message.Body ?? '',
            attributes: Object.fromEntries(
              Object.entries(message.MessageAttributes ?? {}).map(([name, value]) => [
                name,
                value.StringValue ?? '',
              ]),
            ),
          });
          await client.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
          );
        }
      }
    },
    depth: async (queueUrl) => {
      const attributes = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return (
        Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    },
    destroy: async () => {
      for (const url of [urls.transactions, urls.events, urls.deadLetter]) {
        await client.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
      client.destroy();
    },
  };
}
