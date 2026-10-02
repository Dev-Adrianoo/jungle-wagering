import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  StaleTransactionError,
  StaleWalletVersionError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../../src/application/errors';
import { buildCore, type Core } from '../../../src/composition/core';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering/wager-transaction';
import { brl } from '../../support/builders';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { newTransaction, newWallet } from '../../support/persisted';
import { rejectionOf } from '../../support/rejection';

let db: TestDatabase;
let core: Core;

beforeAll(async () => {
  db = await createTestDatabase();
  core = buildCore(db.orm, { lockTimeoutMs: 3000 });
});

afterAll(async () => {
  await db.drop();
});

async function persistedWallet(balance = '100.00') {
  const { wallet } = newWallet(balance);
  await core.uow.run(() => core.wallets.insert(wallet));
  return wallet;
}

describe('unit of work', () => {
  test('commits what the work wrote', async () => {
    const wallet = await persistedWallet();
    expect(await core.uow.read(() => core.wallets.findById(wallet.id))).toBeDefined();
  });

  test('rolls everything back when the work throws', async () => {
    const { wallet } = newWallet('100.00');

    const error = await rejectionOf(
      core.uow.run(async () => {
        await core.wallets.insert(wallet);
        throw new Error('boom');
      }),
    );

    expect((error as Error).message).toBe('boom');
    expect(await core.uow.read(() => core.wallets.findById(wallet.id))).toBeUndefined();
  });

  test('repositories cannot be used outside run or read', async () => {
    const error = await rejectionOf(core.wallets.findById(randomUUID()));

    expect((error as Error).message).toMatch(/outside a unit of work/);
  });

  test('a unique violation is translated and names the constraint', async () => {
    const wallet = await persistedWallet();
    const first = newTransaction(wallet);
    first.markProcessed(undefined, brl('75.00'), new Date());
    const second = newTransaction(wallet, { idempotencyKey: first.idempotencyKey });
    second.markProcessed(undefined, brl('75.00'), new Date());
    await core.uow.run(() => core.transactions.insert(first));

    const error = await rejectionOf(core.uow.run(() => core.transactions.insert(second)));

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error).toMatchObject({ constraint: 'wager_tx_idempotency_key_unique' });
  });
});

describe('wallet repository', () => {
  test('round-trips a wallet with an exact balance', async () => {
    const wallet = await persistedWallet('1234567890.12');

    const loaded = await core.uow.read(() => core.wallets.findById(wallet.id));

    expect(loaded?.balance.toJSON()).toEqual({ amount: '1234567890.12', currency: 'BRL' });
    expect(loaded?.version).toBe(1);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.createdAt).toEqual(wallet.createdAt);
  });

  test('returns undefined for an unknown wallet', async () => {
    expect(await core.uow.read(() => core.wallets.findById(randomUUID()))).toBeUndefined();
  });

  test('updateBalance persists balance, version and updatedAt', async () => {
    const wallet = await persistedWallet();

    await core.uow.run(async () => {
      const locked = await core.wallets.findByIdForUpdate(wallet.id);
      if (!locked) throw new Error('wallet vanished');
      const expectedVersion = locked.version;
      locked.debit(brl('80.00'), {
        transactionId: randomUUID(),
        entryId: randomUUID(),
        at: new Date(),
      });
      await core.wallets.updateBalance(locked, expectedVersion);
    });

    const loaded = await core.uow.read(() => core.wallets.findById(wallet.id));
    expect(loaded?.balance.toJSON().amount).toBe('20.00');
    expect(loaded?.version).toBe(2);
  });

  test('updateBalance refuses a stale version', async () => {
    const wallet = await persistedWallet();
    wallet.debit(brl('10.00'), {
      transactionId: randomUUID(),
      entryId: randomUUID(),
      at: new Date(),
    });

    const error = await rejectionOf(core.uow.run(() => core.wallets.updateBalance(wallet, 7)));

    expect(error).toBeInstanceOf(StaleWalletVersionError);
  });

  test('findByIdForUpdate needs a transaction', async () => {
    const wallet = await persistedWallet();

    const error = await rejectionOf(core.uow.read(() => core.wallets.findByIdForUpdate(wallet.id)));

    expect(error).toBeInstanceOf(Error);
  });

  test('a second transaction waits for the row lock and times out as transient', async () => {
    const wallet = await persistedWallet();
    const impatient = buildCore(db.orm, { lockTimeoutMs: 200 });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announceLock = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      announceLock = resolve;
    });

    const holder = core.uow.run(async () => {
      await core.wallets.findByIdForUpdate(wallet.id);
      announceLock();
      await released;
    });
    await lockTaken;

    const error = await rejectionOf(
      impatient.uow.run(() => impatient.wallets.findByIdForUpdate(wallet.id)),
    );

    expect(error).toBeInstanceOf(TransientInfrastructureError);

    release();
    await holder;
  });
});

describe('transaction repository', () => {
  test('round-trips a processed transaction and finds it by every key', async () => {
    const wallet = await persistedWallet();
    const tx = newTransaction(wallet);
    tx.markProcessed(undefined, brl('75.00'), new Date());
    await core.uow.run(() => core.transactions.insert(tx));

    const [byId, byKey, byExternal] = await core.uow.read(() =>
      Promise.all([
        core.transactions.findById(tx.id),
        core.transactions.findByIdempotencyKey(tx.idempotencyKey),
        core.transactions.findByProviderAndExternalId(tx.providerId, tx.externalTransactionId),
      ]),
    );

    expect(byId?.toState()).toEqual(tx.toState());
    expect(byKey?.id).toBe(tx.id);
    expect(byExternal?.id).toBe(tx.id);
  });

  test('round-trips a rejected transaction', async () => {
    const wallet = await persistedWallet();
    const tx = newTransaction(wallet);
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), new Date());
    await core.uow.run(() => core.transactions.insert(tx));

    const loaded = await core.uow.read(() => core.transactions.findById(tx.id));

    expect(loaded?.status).toBe(Status.Rejected);
    expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loaded?.processedAt).toBeUndefined();
  });

  test('round-trips a transaction waiting for its reference', async () => {
    const wallet = await persistedWallet();
    const tx = newTransaction(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: 'ext-bet',
    });
    tx.markPendingReference(brl('100.00'), new Date());
    await core.uow.run(() => core.transactions.insert(tx));

    const loaded = await core.uow.read(() => core.transactions.findById(tx.id));

    expect(loaded?.toState()).toEqual(tx.toState());
  });

  test('update refuses a transaction that is no longer waiting for its reference', async () => {
    const wallet = await persistedWallet();
    const tx = newTransaction(wallet);
    tx.markProcessed(undefined, brl('75.00'), new Date());
    await core.uow.run(() => core.transactions.insert(tx));

    const error = await rejectionOf(core.uow.run(() => core.transactions.update(tx)));

    expect(error).toBeInstanceOf(StaleTransactionError);
  });

  test('isReversed is true only after a PROCESSED reversal', async () => {
    const wallet = await persistedWallet();
    const bet = newTransaction(wallet);
    bet.markProcessed(undefined, brl('75.00'), new Date());
    await core.uow.run(() => core.transactions.insert(bet));

    expect(await core.uow.read(() => core.transactions.isReversed(bet.id))).toBe(false);

    const refund = newTransaction(wallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    refund.markProcessed(bet.id, brl('100.00'), new Date());
    await core.uow.run(() => core.transactions.insert(refund));

    expect(await core.uow.read(() => core.transactions.isReversed(bet.id))).toBe(true);
  });
});

describe('ledger repository', () => {
  async function walletWithMovements() {
    const { wallet } = newWallet('0');
    await core.uow.run(() => core.wallets.insert(wallet));
    for (const amount of ['50.00', '30.00', '20.00']) {
      await core.uow.run(async () => {
        const locked = await core.wallets.findByIdForUpdate(wallet.id);
        if (!locked) throw new Error('wallet vanished');
        const expectedVersion = locked.version;
        const tx = newTransaction(locked, { kind: Kind.Win, money: brl(amount) });
        const entry = locked.credit(brl(amount), {
          transactionId: tx.id,
          entryId: randomUUID(),
          at: new Date(),
        });
        tx.markProcessed(undefined, locked.balance, new Date());
        await core.transactions.insert(tx);
        await core.wallets.updateBalance(locked, expectedVersion);
        await core.ledger.insert(entry);
      });
    }
    return wallet;
  }

  test('pages entries in insertion order', async () => {
    const wallet = await walletWithMovements();

    const first = await core.uow.read(() => core.ledger.page(wallet.id, undefined, 2));
    const lastSeq = first.entries.at(-1)?.seq;
    const second = await core.uow.read(() => core.ledger.page(wallet.id, lastSeq, 2));

    expect(first.entries.map(({ entry }) => entry.money.toJSON().amount)).toEqual([
      '50.00',
      '30.00',
    ]);
    expect(first.hasMore).toBe(true);
    expect(second.entries.map(({ entry }) => entry.money.toJSON().amount)).toEqual(['20.00']);
    expect(second.hasMore).toBe(false);
    expect(first.entries.every(({ entry }) => entry.isBalanced())).toBe(true);
  });

  test('summarize compares the stored balance with the ledger sum', async () => {
    const wallet = await walletWithMovements();

    const summary = await core.uow.read(() => core.ledger.summarize(wallet.id));

    expect(summary?.storedBalance.toJSON().amount).toBe('100.00');
    expect(summary?.calculatedBalance.toJSON().amount).toBe('100.00');
    expect(summary?.entries).toBe(3);
  });

  test('summarize of a wallet without entries calculates zero', async () => {
    const wallet = await persistedWallet('0');

    const summary = await core.uow.read(() => core.ledger.summarize(wallet.id));

    expect(summary?.calculatedBalance.toJSON().amount).toBe('0.00');
    expect(summary?.entries).toBe(0);
  });

  test('summarize of an unknown wallet is undefined', async () => {
    expect(await core.uow.read(() => core.ledger.summarize(randomUUID()))).toBeUndefined();
  });
});

describe('outbox repository', () => {
  test('stores the serialized event as pending', async () => {
    const wallet = await persistedWallet();
    const entry = wallet.debit(brl('25.00'), {
      transactionId: randomUUID(),
      entryId: randomUUID(),
      at: new Date(),
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: randomUUID(),
      correlationId: 'corr-1',
      causationId: undefined,
      occurredAt: new Date(),
    });

    await core.uow.run(() => core.outbox.insert(OutboxMessage.enqueue(event)));

    const rows = await db.query<{ event_type: string; payload: unknown; published_at: unknown }>(
      'select event_type, payload, published_at from outbox_messages where id = ?',
      [event.eventId],
    );
    expect(rows[0]?.event_type).toBe('WalletBalanceChanged');
    expect(rows[0]?.payload).toEqual(JSON.parse(JSON.stringify(event)));
    expect(rows[0]?.published_at).toBeNull();
  });
});
