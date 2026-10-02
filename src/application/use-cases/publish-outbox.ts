// Runs after the financial transaction committed, never inside it. The rows stay locked
// while the batch is sent, so the batch is small. If the process dies between the send and
// the commit below, the rows are still pending and another instance sends them again with
// the same event id: at-least-once delivery, never lost, safe to repeat.
import { safely } from '../observability/safely';
import type { Clock } from '../ports/clock';
import type { CrashPoint } from '../ports/crash-point';
import type { EventPublisher } from '../ports/event-publisher';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { OutboxRepository } from '../ports/outbox-repository';
import type { UnitOfWork } from '../ports/unit-of-work';

export const OUTBOX_BATCH_SIZE = 10;

export interface PublishOutboxDependencies {
  uow: UnitOfWork;
  outbox: OutboxRepository;
  publisher: EventPublisher;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  crashPoint: CrashPoint;
}

export class PublishOutbox {
  constructor(private readonly deps: PublishOutboxDependencies) {}

  execute(): Promise<number> {
    const { uow, outbox, publisher, clock, logger, crashPoint } = this.deps;
    return uow.run(async () => {
      const now = clock.now();
      const due = await outbox.claimDue(now, OUTBOX_BATCH_SIZE);
      if (due.length === 0) {
        return 0;
      }
      const accepted = await publisher.publish(due);
      crashPoint.reached('outbox.after-publish-before-mark');
      for (const message of due) {
        if (accepted.has(message.id)) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now);
          safely(() =>
            logger.warn('outbox.retry_scheduled', {
              eventId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
            }),
          );
        }
        await outbox.save(message);
      }
      return due.length;
    });
  }

  async observe(): Promise<void> {
    const { uow, outbox, clock, metrics } = this.deps;
    const stats = await uow.read(() => outbox.stats(clock.now()));
    safely(() => metrics.outboxObserved(stats.pending, stats.lagSeconds));
  }
}
