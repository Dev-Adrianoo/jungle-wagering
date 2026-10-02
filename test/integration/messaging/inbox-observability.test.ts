import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IdempotencyKeyConflictError } from '../../../src/application/errors';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type { LogFields, Logger } from '../../../src/application/ports/logger';
import type { SubmitWagerCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { rejectionOf } from '../../support/rejection';

interface Line {
  level: string;
  event: string;
  fields: LogFields | undefined;
}

const lines: Line[] = [];
const at =
  (level: string) =>
  (event: string, fields?: LogFields): void => {
    lines.push({ level, event, fields });
  };
const logger: Logger = { info: at('info'), warn: at('warn'), error: at('error') };

let db: TestDatabase;
let core: Core;
let metrics: PrometheusMetrics;

beforeAll(async () => {
  db = await createTestDatabase();
  metrics = new PrometheusMetrics();
  core = buildCore(db.orm, { lockTimeoutMs: 5000, logger, metrics });
});

afterAll(async () => {
  await db.drop();
});

const open = () =>
  core.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId: 'corr-open',
  });

function command(wallet: WalletView, amount = '25.00'): SubmitWagerCommand {
  const payload: WagerPayload = {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
  return {
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    correlationId: 'corr-msg',
    source: 'sqs',
  };
}

const inboxFor = (messageId = `msg-${randomUUID()}`) => ({
  consumerName: 'wager-transaction-consumer',
  messageId,
  payloadHash: 'a'.repeat(64),
});

const counter = async (pattern: RegExp) => Number(pattern.exec(await metrics.render())?.[1] ?? 0);
const processedBets = () =>
  counter(/wager_transactions_total\{status="PROCESSED",kind="BET",source="sqs"\} (\d+)/);
const sqsDuplicates = () => counter(/wager_duplicates_total\{source="sqs"\} (\d+)/);
const conflicts = () => counter(/wager_idempotency_conflicts_total (\d+)/);

describe('executeFromMessage observability', () => {
  test('a processed message is counted and logged as a transaction from sqs', async () => {
    const wallet = await open();
    const before = await processedBets();
    const request = command(wallet);

    await core.submitWager.executeFromMessage(request, inboxFor());

    expect(await processedBets()).toBe(before + 1);
    expect(lines.filter((line) => line.event === 'wager.transaction')).toContainEqual(
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({ correlationId: 'corr-msg', source: 'sqs' }),
      }),
    );
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a duplicate message is counted and logged with its message id', async () => {
    const wallet = await open();
    const request = command(wallet);
    const inbox = inboxFor('msg-observed-duplicate');
    await core.submitWager.executeFromMessage(request, inbox);
    const before = await sqsDuplicates();

    await core.submitWager.executeFromMessage(request, inbox);

    expect(await sqsDuplicates()).toBe(before + 1);
    expect(lines.filter((line) => line.event === 'wager.duplicate_message')).toEqual([
      {
        level: 'info',
        event: 'wager.duplicate_message',
        fields: { correlationId: 'corr-msg', messageId: 'msg-observed-duplicate' },
      },
    ]);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('an idempotency conflict seen through a message is counted', async () => {
    const wallet = await open();
    const request = command(wallet);
    await core.submitWager.executeFromMessage(request, inboxFor());
    const before = await conflicts();

    const error = await rejectionOf(
      core.submitWager.executeFromMessage(
        {
          ...request,
          payload: { ...request.payload, money: { amount: '26.00', currency: 'BRL' } },
        },
        inboxFor(),
      ),
    );

    expect(error).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(await conflicts()).toBe(before + 1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('every message, duplicate or not, observes its processing time', async () => {
    const wallet = await open();
    const inbox = inboxFor();
    const request = command(wallet);
    const before = await counter(/wager_processing_duration_seconds_count\{source="sqs"\} (\d+)/);

    await core.submitWager.executeFromMessage(request, inbox);
    await core.submitWager.executeFromMessage(request, inbox);

    expect(await counter(/wager_processing_duration_seconds_count\{source="sqs"\} (\d+)/)).toBe(
      before + 2,
    );
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
