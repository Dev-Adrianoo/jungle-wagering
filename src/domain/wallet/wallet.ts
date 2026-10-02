import { CurrencyMismatchError, Money } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(walletId: string) {
    super(`wallet ${walletId} has insufficient funds`);
  }
}

export class NonPositiveAmountError extends DomainError {
  readonly code = 'NON_POSITIVE_AMOUNT';

  constructor() {
    super('a balance movement must be greater than zero');
  }
}

export class NegativeInitialBalanceError extends DomainError {
  readonly code = 'NEGATIVE_INITIAL_BALANCE';

  constructor() {
    super('initial balance cannot be negative');
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementRef {
  transactionId: string;
  entryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new NegativeInitialBalanceError();
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(props.initialBalance.currency),
      balanceAfter: props.initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, ref: MovementRef): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, money, ref);
  }

  credit(money: Money, ref: MovementRef): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, money, ref);
  }

  private move(direction: LedgerDirection, money: Money, ref: MovementRef): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new NonPositiveAmountError();
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(this.id);
    }
    const entry = WalletLedgerEntry.create({
      id: ref.entryId,
      walletId: this.id,
      transactionId: ref.transactionId,
      walletVersion: this._version + 1,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ref.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ref.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
