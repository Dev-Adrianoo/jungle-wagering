import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
}
