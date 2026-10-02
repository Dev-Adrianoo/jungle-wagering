import type { OutboxRepository } from '../../../application/ports/outbox-repository';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { toOutboxRecord } from '../mappers';
import type { MikroOrmUnitOfWork } from '../mikro-orm-unit-of-work';
import { OutboxMessageRecord } from '../records';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.uow.em().insert(OutboxMessageRecord, toOutboxRecord(message));
  }
}
