import type { MoneyProps } from '../domain/money/money';
import type { FailureCode } from '../domain/wagering/failure-code';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toTransactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    ...(transaction.roundId === undefined ? {} : { roundId: transaction.roundId }),
    ...(transaction.gameId === undefined ? {} : { gameId: transaction.gameId }),
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: transaction.referenceTransactionId }),
    balance: transaction.observedBalance.toJSON(),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt === undefined
      ? {}
      : { processedAt: transaction.processedAt.toISOString() }),
  };
}

export function toSubmitResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): SubmitWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance.toJSON(),
    idempotentReplay,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
  };
}
