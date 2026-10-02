import { describe, expect, test } from 'bun:test';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';

describe('PrometheusMetrics', () => {
  test('exposes every metric under its documented name', async () => {
    const metrics = new PrometheusMetrics();

    metrics.transactionRecorded('PROCESSED', 'BET', 'http');
    metrics.transactionRecorded('PROCESSED', 'BET', 'http');
    metrics.transactionRecorded('REJECTED', 'BET', 'sqs');
    metrics.duplicateDetected('sqs');
    metrics.idempotencyConflict();
    metrics.lockConflict();
    metrics.processingObserved(0.012, 'http');
    metrics.messageRetried();
    metrics.messageDeadLettered('INVALID_MESSAGE');
    metrics.outboxObserved(7, 3.5);
    metrics.reconciliationDivergence();

    const text = await metrics.render();

    expect(text).toContain(
      'wager_transactions_total{status="PROCESSED",kind="BET",source="http"} 2',
    );
    expect(text).toContain('wager_transactions_total{status="REJECTED",kind="BET",source="sqs"} 1');
    expect(text).toContain('wager_duplicates_total{source="sqs"} 1');
    expect(text).toContain('wager_idempotency_conflicts_total 1');
    expect(text).toContain('wallet_lock_conflicts_total 1');
    expect(text).toContain('wager_processing_duration_seconds_count{source="http"} 1');
    expect(text).toContain('sqs_retries_total 1');
    expect(text).toContain('sqs_dlq_messages_total{reason="INVALID_MESSAGE"} 1');
    expect(text).toContain('outbox_pending 7');
    expect(text).toContain('outbox_lag_seconds 3.5');
    expect(text).toContain('reconciliation_divergences_total 1');
  });

  test('two instances keep separate registries', async () => {
    const first = new PrometheusMetrics();
    const second = new PrometheusMetrics();

    first.lockConflict();

    expect(await second.render()).toContain('wallet_lock_conflicts_total 0');
  });
});
