// Decides what happens to one message. Business answers (including a rejection) are final
// and acknowledged; a message that can never succeed goes to the dead-letter queue; only
// failures that may pass on their own are retried.
import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import { safely } from '../../application/observability/safely';
import type { Logger } from '../../application/ports/logger';
import type { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction';
import { DomainError } from '../../domain/shared/domain-error';
import { runWithLogContext } from '../../infrastructure/observability/log-context';
import { RequestValidationError } from '../contracts/parse';
import { parseWagerMessage } from '../contracts/wager-message.schema';

export const WAGER_CONSUMER_NAME = 'wager-transaction-consumer';

export type Disposition =
  | { action: 'ack'; outcome: 'processed' | 'duplicate' }
  | { action: 'dead-letter'; reason: string }
  | { action: 'retry' };

const PERMANENT_CODES = new Set([
  'IDEMPOTENCY_KEY_CONFLICT',
  'DUPLICATE_EXTERNAL_TRANSACTION',
  'WALLET_NOT_FOUND',
  'MESSAGE_ID_REUSED',
]);

export class WagerMessageHandler {
  constructor(
    private readonly submitWager: Pick<SubmitWagerTransaction, 'executeFromMessage'>,
    private readonly logger: Logger,
  ) {}

  async handle(body: string): Promise<Disposition> {
    let message: ReturnType<typeof parseWagerMessage>;
    try {
      message = parseWagerMessage(body);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        safely(() => this.logger.warn('sqs.invalid_message', {}));
        return { action: 'dead-letter', reason: 'INVALID_MESSAGE' };
      }
      throw error;
    }

    return runWithLogContext(
      { correlationId: message.correlationId, messageId: message.messageId },
      async () => {
        try {
          const outcome = await this.submitWager.executeFromMessage(
            {
              idempotencyKey: message.idempotencyKey,
              payload: message.payload,
              correlationId: message.correlationId,
              source: 'sqs',
            },
            {
              consumerName: WAGER_CONSUMER_NAME,
              messageId: message.messageId,
              payloadHash: message.payloadHash,
            },
          );
          return { action: 'ack', outcome: outcome.duplicate ? 'duplicate' : 'processed' };
        } catch (error) {
          return this.classify(error);
        }
      },
    );
  }

  private classify(error: unknown): Disposition {
    if (error instanceof TransientInfrastructureError) {
      safely(() => this.logger.warn('sqs.transient_failure', { code: error.code }));
      return { action: 'retry' };
    }
    if (error instanceof ApplicationError && PERMANENT_CODES.has(error.code)) {
      safely(() => this.logger.warn('sqs.permanent_failure', { code: error.code }));
      return { action: 'dead-letter', reason: error.code };
    }
    if (error instanceof DomainError) {
      safely(() => this.logger.warn('sqs.permanent_failure', { code: error.code }));
      return { action: 'dead-letter', reason: error.code };
    }
    safely(() =>
      this.logger.error('sqs.unexpected_failure', {
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { action: 'retry' };
  }
}
