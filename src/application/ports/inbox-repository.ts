import type { InboxMessage } from '../../domain/messaging/inbox-message';

export interface InboxRepository {
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}
