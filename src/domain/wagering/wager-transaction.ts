import { Money } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const INTERNAL_PROVIDER_ID = 'internal';

export const REFERENCE_RETRY_POLICY = {
  baseDelayMs: 5_000,
  factor: 2,
  maxDelayMs: 300_000,
  maxAttempts: 10,
} as const;

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  observedBalance: Money;
  referenceAttempts: number;
  nextAttemptAt: Date | undefined;
  updatedAt: Date;
  processedAt: Date | undefined;
}

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const REVERSALS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextAttemptAt: Date | undefined;
  private _updatedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    props: CreateWagerTransactionProps,
    mutable: {
      status: WagerTransactionStatus;
      referenceTransactionId: string | undefined;
      failureCode: FailureCode | undefined;
      observedBalance: Money | undefined;
      referenceAttempts: number;
      nextAttemptAt: Date | undefined;
      updatedAt: Date;
      processedAt: Date | undefined;
    },
  ) {
    this.id = props.id;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.idempotencyKey = props.idempotencyKey;
    this.payloadHash = props.payloadHash;
    this.walletId = props.walletId;
    this.playerId = props.playerId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.money = props.money;
    this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    this.correlationId = props.correlationId;
    this.createdAt = props.createdAt;
    this._status = mutable.status;
    this._referenceTransactionId = mutable.referenceTransactionId;
    this._failureCode = mutable.failureCode;
    this._observedBalance = mutable.observedBalance;
    this._referenceAttempts = mutable.referenceAttempts;
    this._nextAttemptAt = mutable.nextAttemptAt;
    this._updatedAt = mutable.updatedAt;
    this._processedAt = mutable.processedAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (REVERSALS.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference transaction`);
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('transaction amount cannot be negative');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be greater than zero`);
    }
    if (props.kind !== WagerTransactionKind.Opening && (!props.roundId || !props.gameId)) {
      throw new InvalidWagerTransactionError(`${props.kind} requires roundId and gameId`);
    }
    return new WagerTransaction(props, {
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextAttemptAt: undefined,
      updatedAt: props.createdAt,
      processedAt: undefined,
    });
  }

  /** Rebuilds persisted state. Does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state, {
      status: state.status,
      referenceTransactionId: state.referenceTransactionId,
      failureCode: state.failureCode,
      observedBalance: state.observedBalance,
      referenceAttempts: state.referenceAttempts,
      nextAttemptAt: state.nextAttemptAt,
      updatedAt: state.updatedAt,
      processedAt: state.processedAt,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Wallet balance seen when the current status was decided. Returned on replays. */
  get observedBalance(): Money {
    if (!this._observedBalance) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id} has no observed balance while ${this._status}`,
      );
    }
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    observedBalance: Money,
    at: Date,
  ): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
    this._processedAt = at;
    this._updatedAt = at;
  }

  markPendingReference(observedBalance: Money, now: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw this.invalidTransition(WagerTransactionStatus.PendingReference);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._referenceAttempts = 0;
    this._nextAttemptAt = new Date(now.getTime() + REFERENCE_RETRY_POLICY.baseDelayMs);
    this._updatedAt = now;
  }

  /** The reference is still missing. Schedules the next retry, or rejects once exhausted. */
  registerReferenceMiss(observedBalance: Money, now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw this.invalidTransition(WagerTransactionStatus.PendingReference);
    }
    this._referenceAttempts += 1;
    if (this._referenceAttempts >= REFERENCE_RETRY_POLICY.maxAttempts) {
      this.reject(FailureCode.ReferenceNotFound, observedBalance, now);
      return;
    }
    const delay = Math.min(
      REFERENCE_RETRY_POLICY.baseDelayMs * REFERENCE_RETRY_POLICY.factor ** this._referenceAttempts,
      REFERENCE_RETRY_POLICY.maxDelayMs,
    );
    this._observedBalance = observedBalance;
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._updatedAt = now;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSALS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK needs its reference to pick a direction',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not move the balance');
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      correlationId: this.correlationId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      observedBalance: this.observedBalance,
      referenceAttempts: this._referenceAttempts,
      nextAttemptAt: this._nextAttemptAt,
      updatedAt: this._updatedAt,
      processedAt: this._processedAt,
    };
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw this.invalidTransition(target);
    }
  }

  private invalidTransition(target: WagerTransactionStatus): InvalidTransactionStateError {
    return new InvalidTransactionStateError(
      `transaction ${this.id} cannot go from ${this._status} to ${target}`,
    );
  }
}
