import type { InboxRepository } from '../../../application/ports/inbox-repository';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import type { MikroOrmUnitOfWork } from '../mikro-orm-unit-of-work';

interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: string | Date;
  processed_at: string | Date | null;
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  // ON CONFLICT DO NOTHING waits for a concurrent delivery of the same message to commit or
  // roll back, so exactly one delivery gets `true` and every other one sees the row.
  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const state = message.toState();
    const inserted: unknown[] = await this.uow.em().execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        state.consumerName,
        state.messageId,
        state.payloadHash,
        state.receivedAt,
        state.processedAt ?? null,
      ],
    );
    return inserted.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const rows: InboxRow[] = await this.uow.em().execute(
      `select consumer_name, message_id, payload_hash, received_at, processed_at
       from inbox_messages where consumer_name = ? and message_id = ?`,
      [consumerName, messageId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return InboxMessage.rehydrate({
      consumerName: row.consumer_name,
      messageId: row.message_id,
      payloadHash: row.payload_hash,
      receivedAt: new Date(row.received_at),
      processedAt: row.processed_at === null ? undefined : new Date(row.processed_at),
    });
  }
}
