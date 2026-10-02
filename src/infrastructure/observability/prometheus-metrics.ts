// Each instance owns a registry, so tests and several app instances in one process never
// share counters. Counters without labels are initialised at zero so they are visible
// before the first event.
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Metrics, TransactionSource } from '../../application/ports/metrics';

export class PrometheusMetrics implements Metrics {
  private readonly registry = new Registry();
  readonly contentType = this.registry.contentType;

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by final status, kind and entry point',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Requests or messages recognised as a repeat of one already handled',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Idempotency keys reused with a different payload',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Transactions that gave up waiting for a wallet row lock',
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Time to process one wager transaction',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'sqs_retries_total',
    help: 'Messages left on the queue for another attempt',
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Messages moved to the dead-letter queue',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'outbox_pending',
    help: 'Outbox messages not published yet',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance differed from the ledger',
    registers: [this.registry],
  });

  transactionRecorded(status: string, kind: string, source: TransactionSource): void {
    this.transactions.inc({ status, kind, source });
  }

  duplicateDetected(source: TransactionSource): void {
    this.duplicates.inc({ source });
  }

  idempotencyConflict(): void {
    this.idempotencyConflicts.inc();
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  processingObserved(seconds: number, source: TransactionSource): void {
    this.processing.observe({ source }, seconds);
  }

  messageRetried(): void {
    this.retries.inc();
  }

  messageDeadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  outboxObserved(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(lagSeconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
