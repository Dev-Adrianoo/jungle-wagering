import type { OutboxMessage } from '../../domain/messaging/outbox-message';

// Returns the ids that were accepted. A failed send is reported by leaving the id out, not
// by throwing: the caller schedules a retry for whatever is missing.
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>>;
}
