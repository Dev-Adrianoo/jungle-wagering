export type TransactionSource = 'http' | 'sqs' | 'worker';

export interface Metrics {
  transactionRecorded(status: string, kind: string, source: TransactionSource): void;
  duplicateDetected(source: TransactionSource): void;
  idempotencyConflict(): void;
  lockConflict(): void;
  processingObserved(seconds: number, source: TransactionSource): void;
  messageRetried(): void;
  messageDeadLettered(reason: string): void;
  outboxObserved(pending: number, lagSeconds: number): void;
  reconciliationDivergence(): void;
}
