// Every instance runs the same three workers and they coordinate only through the database
// and the queue, so there is no special instance. On shutdown the consumer stops first, so
// no new message starts, and the two loops finish the cycle they are in. The resolver always
// reports no work: a transaction still missing its reference only becomes due again after
// its backoff, so running again at once would only hammer the database.
import { safely } from '../../application/observability/safely';
import type { Logger } from '../../application/ports/logger';
import type { Core } from '../../composition/core';
import { PollingWorker } from './polling-worker';
import type { SqsWagerConsumer } from './sqs-wager-consumer';

const OUTBOX_IDLE_DELAY_MS = 500;
const PENDING_REFERENCE_IDLE_DELAY_MS = 1_000;

export interface WorkersDependencies {
  core: Core;
  consumer: SqsWagerConsumer;
  logger: Logger;
}

export class Workers {
  private readonly outbox: PollingWorker;
  private readonly pendingReferences: PollingWorker;

  constructor(private readonly deps: WorkersDependencies) {
    const { core, logger } = deps;
    this.outbox = new PollingWorker(
      'outbox-publisher',
      OUTBOX_IDLE_DELAY_MS,
      async () => {
        const published = await core.publishOutbox.execute();
        await core.publishOutbox.observe();
        return published;
      },
      logger,
    );
    this.pendingReferences = new PollingWorker(
      'pending-reference-resolver',
      PENDING_REFERENCE_IDLE_DELAY_MS,
      async () => {
        await core.resolvePendingReferences.execute();
        return 0;
      },
      logger,
    );
  }

  start(): void {
    this.deps.consumer.start();
    this.outbox.start();
    this.pendingReferences.start();
    safely(() => this.deps.logger.info('workers.started', {}));
  }

  async stop(): Promise<void> {
    await this.deps.consumer.stop();
    await Promise.all([this.outbox.stop(), this.pendingReferences.stop()]);
    safely(() => this.deps.logger.info('workers.stopped', {}));
  }
}
