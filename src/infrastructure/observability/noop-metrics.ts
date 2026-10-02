import type { Metrics } from '../../application/ports/metrics';

export class NoopMetrics implements Metrics {
  transactionRecorded(): void {}
  duplicateDetected(): void {}
  idempotencyConflict(): void {}
  lockConflict(): void {}
  processingObserved(): void {}
  messageRetried(): void {}
  messageDeadLettered(): void {}
  outboxObserved(): void {}
  reconciliationDivergence(): void {}
}
