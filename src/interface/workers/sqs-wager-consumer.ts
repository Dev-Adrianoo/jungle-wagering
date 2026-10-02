// Long-polls the transactions queue. A message is deleted only after the handler returned,
// that is, after the database commit. Within a batch, once a message of a group has to be
// retried, the later messages of that group are released untouched: processing them would
// break the order the FIFO queue guarantees for that wallet. stop() waits for the poll in
// progress instead of aborting it: an aborted long poll can still be answered by the queue,
// and the message it carries would stay invisible until its visibility timeout expires.
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { safely } from '../../application/observability/safely';
import type { CrashPoint } from '../../application/ports/crash-point';
import type { Logger } from '../../application/ports/logger';
import type { Metrics } from '../../application/ports/metrics';
import { MAX_RECEIVE_COUNT, type QueueUrls } from '../../infrastructure/sqs/queues';
import type { WagerMessageHandler } from './wager-message-handler';

export interface ConsumerOptions {
  waitTimeSeconds: number;
  batchSize: number;
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
}

export interface ConsumerDependencies {
  client: SQSClient;
  urls: QueueUrls;
  handler: WagerMessageHandler;
  metrics: Metrics;
  logger: Logger;
  crashPoint: CrashPoint;
  options: ConsumerOptions;
}

const RECEIVE_FAILURE_PAUSE_MS = 1_000;

export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly deps: ConsumerDependencies) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const messages = await this.receive();
      const blockedGroups = new Set<string>();
      for (const message of messages) {
        const group = message.Attributes?.MessageGroupId ?? '';
        try {
          if (!this.running || blockedGroups.has(group)) {
            await this.changeVisibility(message, 0);
            continue;
          }
          if (await this.process(message)) {
            blockedGroups.add(group);
          }
        } catch (error) {
          blockedGroups.add(group);
          safely(() =>
            this.deps.logger.error('sqs.message_failed', {
              sqsMessageId: message.MessageId,
              error: error instanceof Error ? error.name : typeof error,
            }),
          );
        }
      }
    }
  }

  private async receive(): Promise<Message[]> {
    const { client, urls, options, logger } = this.deps;
    try {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: urls.transactions,
          MaxNumberOfMessages: options.batchSize,
          WaitTimeSeconds: options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
      );
      return response.Messages ?? [];
    } catch (error) {
      if (this.running) {
        safely(() =>
          logger.error('sqs.receive_failed', {
            error: error instanceof Error ? error.name : typeof error,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, RECEIVE_FAILURE_PAUSE_MS));
      }
      return [];
    }
  }

  private async process(message: Message): Promise<boolean> {
    const { handler, crashPoint, metrics, options } = this.deps;
    const disposition = await handler.handle(message.Body ?? '');
    crashPoint.reached('consumer.after-commit-before-ack');

    if (disposition.action === 'ack') {
      await this.delete(message);
      return false;
    }
    if (disposition.action === 'dead-letter') {
      await this.deadLetter(message, disposition.reason);
      return false;
    }
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    if (receiveCount >= MAX_RECEIVE_COUNT) {
      await this.deadLetter(message, 'RETRIES_EXHAUSTED');
      return false;
    }
    safely(() => metrics.messageRetried());
    const backoff = Math.min(
      options.baseBackoffSeconds * 2 ** (receiveCount - 1),
      options.maxBackoffSeconds,
    );
    await this.changeVisibility(message, backoff);
    return true;
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    const { client, urls, metrics, logger } = this.deps;
    await client.send(
      new SendMessageCommand({
        QueueUrl: urls.deadLetter,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId || 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    await this.delete(message);
    safely(() => metrics.messageDeadLettered(reason));
    safely(() => logger.warn('sqs.dead_lettered', { reason, sqsMessageId: message.MessageId }));
  }

  private async delete(message: Message): Promise<void> {
    await this.deps.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.deps.urls.transactions,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.deps.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.deps.urls.transactions,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
