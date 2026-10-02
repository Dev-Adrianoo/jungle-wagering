import { WalletNotFoundError } from '../errors';
import { safely } from '../observability/safely';
import type { LedgerRepository } from '../ports/ledger-repository';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { ReconciliationView } from '../views';

// Reports whether the stored balance equals the ledger sum. It never repairs a divergence:
// a silent fix would hide the bug that caused it.
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ledger: LedgerRepository,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  execute(walletId: string): Promise<ReconciliationView> {
    return this.uow.read(async () => {
      const summary = await this.ledger.summarize(walletId);
      if (!summary) {
        throw new WalletNotFoundError(walletId);
      }
      const difference = summary.storedBalance.subtract(summary.calculatedBalance);
      const view: ReconciliationView = {
        walletId,
        storedBalance: summary.storedBalance.toJSON(),
        calculatedBalance: summary.calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
      if (!view.consistent) {
        safely(() => this.metrics.reconciliationDivergence());
        safely(() =>
          this.logger.error('reconciliation.divergence', {
            walletId,
            checkedEntries: view.checkedEntries,
          }),
        );
      }
      return view;
    });
  }
}
