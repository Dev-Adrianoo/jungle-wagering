import { LockMode } from '@mikro-orm/core';
import type { OutboxRepository, OutboxStats } from '../../../application/ports/outbox-repository';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { toOutboxMessage, toOutboxRecord } from '../mappers';
import type { MikroOrmUnitOfWork } from '../mikro-orm-unit-of-work';
import { OutboxMessageRecord } from '../records';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.uow.em().insert(OutboxMessageRecord, toOutboxRecord(message));
  }

  // Rows already locked by another publisher are skipped, not waited for (SKIP LOCKED), so
  // concurrent publishers take disjoint rows and never queue behind each other.
  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.uow.em().find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return records.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    const state = message.toState();
    await this.uow.em().nativeUpdate(
      OutboxMessageRecord,
      { id: state.id },
      {
        attempts: state.attempts,
        nextAttemptAt: state.nextAttemptAt ?? null,
        publishedAt: state.publishedAt ?? null,
      },
    );
  }

  async stats(now: Date): Promise<OutboxStats> {
    const rows: Array<{ pending: string | number; oldest: string | Date | null }> = await this.uow
      .em()
      .execute(
        'select count(*) as pending, min(occurred_at) as oldest from outbox_messages where published_at is null',
      );
    const row = rows[0];
    const oldest = row?.oldest ? new Date(row.oldest) : undefined;
    return {
      pending: Number(row?.pending ?? 0),
      lagSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}
