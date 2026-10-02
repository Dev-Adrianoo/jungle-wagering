import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxStats {
  pending: number;
  lagSeconds: number;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  stats(now: Date): Promise<OutboxStats>;
}
