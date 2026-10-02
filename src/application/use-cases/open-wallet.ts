import type { EventContext } from '../../domain/events/integration-event';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import { canonicalJson, sha256Hex } from '../idempotency/payload-hash';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { OutboxRepository } from '../ports/outbox-repository';
import type { TransactionRepository } from '../ports/transaction-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { WalletRepository } from '../ports/wallet-repository';
import { toWalletView, type WalletView } from '../views';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletDependencies {
  uow: UnitOfWork;
  wallets: WalletRepository;
  transactions: TransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  clock: Clock;
  ids: IdGenerator;
}

const ONE_WALLET_PER_PLAYER_AND_CURRENCY = 'wallets_player_currency_unique';

export class OpenWallet {
  constructor(private readonly deps: OpenWalletDependencies) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const { uow, wallets, transactions, ledger, outbox, clock, ids } = this.deps;
    const initialBalance = Money.from(command.initialBalance);
    const now = clock.now();
    const walletId = ids.next();
    const openingTransactionId = ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: ids.next(),
      at: now,
    });
    const eventContext = (): EventContext => ({
      eventId: ids.next(),
      correlationId: command.correlationId,
      causationId: openingTransactionId,
      occurredAt: now,
    });

    try {
      await uow.run(async () => {
        await wallets.insert(wallet);
        if (!openingEntry) {
          return;
        }
        const opening = WagerTransaction.create({
          id: openingTransactionId,
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${walletId}`,
          payloadHash: sha256Hex(
            canonicalJson({
              kind: WagerTransactionKind.Opening,
              walletId,
              playerId: command.playerId,
              money: initialBalance.toJSON(),
            }),
          ),
          walletId,
          playerId: command.playerId,
          roundId: undefined,
          gameId: undefined,
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
          referenceExternalTransactionId: undefined,
          correlationId: command.correlationId,
          createdAt: now,
        });
        opening.markProcessed(undefined, wallet.balance, now);
        await transactions.insert(opening);
        await ledger.insert(openingEntry);
        await outbox.insert(
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())),
        );
        await outbox.insert(
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, eventContext())),
        );
      });
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        error.constraint === ONE_WALLET_PER_PLAYER_AND_CURRENCY
      ) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
    return toWalletView(wallet);
  }
}
