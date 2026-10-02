import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

export interface LedgerEntryRow {
  id: string;
  seq: string | number;
  wallet_id: string;
  transaction_id: string;
  wallet_version: number;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string | Date;
}

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

export function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: money(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toWalletRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId ?? undefined,
    gameId: record.gameId ?? undefined,
    kind: record.kind as WagerTransactionKind,
    money: money(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode as FailureCode | null) ?? undefined,
    observedBalance: money(record.observedBalance, record.currency),
    referenceAttempts: record.referenceAttempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    updatedAt: record.updatedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function toTransactionRecord(transaction: WagerTransaction): WagerTransactionRecord {
  const state = transaction.toState();
  return {
    id: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    walletId: state.walletId,
    playerId: state.playerId,
    roundId: state.roundId ?? null,
    gameId: state.gameId ?? null,
    kind: state.kind,
    amount: state.money.toJSON().amount,
    currency: state.money.currency,
    referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
    referenceTransactionId: state.referenceTransactionId ?? null,
    status: state.status,
    failureCode: state.failureCode ?? null,
    observedBalance: state.observedBalance.toJSON().amount,
    referenceAttempts: state.referenceAttempts,
    nextAttemptAt: state.nextAttemptAt ?? null,
    correlationId: state.correlationId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    processedAt: state.processedAt ?? null,
  };
}

export function toLedgerEntryRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    walletVersion: row.wallet_version,
    direction: row.direction as LedgerDirection,
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balance_before, row.currency),
    balanceAfter: money(row.balance_after, row.currency),
    createdAt: new Date(row.created_at),
  });
}

export function toOutboxRecord(message: OutboxMessage): OutboxMessageRecord {
  const state = message.toState();
  return {
    id: state.id,
    aggregateId: state.aggregateId,
    eventType: state.eventType,
    payload: { ...state.payload },
    occurredAt: state.occurredAt,
    attempts: state.attempts,
    nextAttemptAt: state.nextAttemptAt ?? null,
    publishedAt: state.publishedAt ?? null,
  };
}
