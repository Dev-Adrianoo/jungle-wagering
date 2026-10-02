import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MessageIdReusedError } from '../../../src/application/errors';
import type { WagerPayload } from '../../../src/application/idempotency/payload-hash';
import type {
  InboxEnvelope,
  SubmitWagerCommand,
} from '../../../src/application/use-cases/submit-wager-transaction';
import type { WalletView } from '../../../src/application/views';
import { buildCore, type Core } from '../../../src/composition/core';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { expectLedgerMatchesBalance } from '../../support/invariants';
import { rejectionOf } from '../../support/rejection';

const CONSUMER = 'wager-transaction-consumer';

let db: TestDatabase;
let core: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  core = buildCore(db.orm, { lockTimeoutMs: 5000 });
});

afterAll(async () => {
  await db.drop();
});

const open = (amount: string) =>
  core.openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
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

const envelope = (
  messageId = `msg-${randomUUID()}`,
  payloadHash = 'a'.repeat(64),
): InboxEnvelope => ({
  consumerName: CONSUMER,
  messageId,
  payloadHash,
});

const balanceOf = async (walletId: string) =>
  (await core.walletQueries.getWallet(walletId)).balance.amount;
const inboxRows = (messageId: string) =>
  db.query<{ processed_at: Date | null }>(
    'select processed_at from inbox_messages where consumer_name = ? and message_id = ?',
    [CONSUMER, messageId],
  );
const debitsOf = (walletId: string) =>
  db.query(`select id from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [
    walletId,
  ]);

describe('executeFromMessage', () => {
  test('applies the transaction and records the inbox row, already processed', async () => {
    const wallet = await open('100.00');
    const inbox = envelope();

    const outcome = await core.submitWager.executeFromMessage(command(wallet), inbox);

    expect(outcome).toMatchObject({ duplicate: false, result: { status: 'PROCESSED' } });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    const rows = await inboxRows(inbox.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed_at).not.toBeNull();
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a redelivered message is a duplicate and has no second effect', async () => {
    const wallet = await open('100.00');
    const request = command(wallet);
    const inbox = envelope();
    await core.submitWager.executeFromMessage(request, inbox);

    const again = await core.submitWager.executeFromMessage(request, inbox);

    expect(again).toEqual({ duplicate: true });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('the same message id with another payload is refused and changes nothing', async () => {
    const wallet = await open('100.00');
    const inbox = envelope();
    await core.submitWager.executeFromMessage(command(wallet), inbox);

    const error = await rejectionOf(
      core.submitWager.executeFromMessage(command(wallet), {
        ...inbox,
        payloadHash: 'b'.repeat(64),
      }),
    );

    expect(error).toBeInstanceOf(MessageIdReusedError);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('a new message carrying an already processed transaction is a replay, not a second debit', async () => {
    const wallet = await open('100.00');
    const request = command(wallet);
    await core.submitWager.executeFromMessage(request, envelope());

    const outcome = await core.submitWager.executeFromMessage(request, envelope());

    expect(outcome).toMatchObject({ duplicate: false, result: { idempotentReplay: true } });
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('when the transaction rolls back, the inbox row rolls back with it', async () => {
    const wallet = await open('100.00');
    const broken = buildCore(db.orm, {
      lockTimeoutMs: 5000,
      outbox: {
        insert: async () => {
          throw new Error('outbox is down');
        },
        claimDue: async () => [],
        save: async () => {},
        stats: async () => ({ pending: 0, lagSeconds: 0 }),
      },
    });
    const request = command(wallet);
    const inbox = envelope();

    const error = await rejectionOf(broken.submitWager.executeFromMessage(request, inbox));

    expect((error as Error).message).toContain('outbox is down');
    expect(await inboxRows(inbox.messageId)).toHaveLength(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const retried = await core.submitWager.executeFromMessage(request, inbox);
    expect(retried).toMatchObject({ duplicate: false, result: { status: 'PROCESSED' } });
    await expectLedgerMatchesBalance(db, wallet.id);
  });

  test('the same message delivered 20 times in parallel debits exactly once', async () => {
    const wallet = await open('100.00');
    const request = command(wallet);
    const inbox = envelope();

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => core.submitWager.executeFromMessage(request, inbox)),
    );

    expect(outcomes.filter((outcome) => !outcome.duplicate)).toHaveLength(1);
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    expect(await inboxRows(inbox.messageId)).toHaveLength(1);
    await expectLedgerMatchesBalance(db, wallet.id);
  });
});
