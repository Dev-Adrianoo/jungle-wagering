// The event id is the deduplication id: if a publisher dies after sending and before
// recording it, the resend carries the same id, so the queue (within its deduplication
// window) and the consumers can both recognise the repeat.
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/event-publisher';
import type { Logger } from '../../application/ports/logger';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly eventsQueueUrl: string,
    private readonly logger: Logger,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    const accepted = new Set<string>();
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const batch = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const response = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: this.eventsQueueUrl,
            Entries: batch.map((message) => ({
              Id: message.id,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: message.eventType },
              },
            })),
          }),
        );
        for (const entry of response.Successful ?? []) {
          if (entry.Id) {
            accepted.add(entry.Id);
          }
        }
      } catch (error) {
        this.logger.warn('outbox.publish_failed', {
          error: error instanceof Error ? error.name : typeof error,
          batchSize: batch.length,
        });
      }
    }
    return accepted;
  }
}
