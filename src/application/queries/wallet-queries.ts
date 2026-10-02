import { WalletNotFoundError } from '../errors';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { WalletRepository } from '../ports/wallet-repository';
import { type LedgerPageView, toLedgerEntryView, toWalletView, type WalletView } from '../views';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export class WalletQueries {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.uow.read(async () => {
      const wallet = await this.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      return toWalletView(wallet);
    });
  }

  async getLedger(
    walletId: string,
    options: { cursor: string | undefined; limit: number },
  ): Promise<LedgerPageView> {
    const afterSeq = options.cursor === undefined ? undefined : decodeLedgerCursor(options.cursor);
    return this.uow.read(async () => {
      if (!(await this.wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      const page = await this.ledger.page(walletId, afterSeq, options.limit);
      const last = page.entries.at(-1);
      return {
        items: page.entries.map(({ entry }) => toLedgerEntryView(entry)),
        nextCursor: page.hasMore && last ? encodeLedgerCursor(last.seq) : null,
      };
    });
  }
}
