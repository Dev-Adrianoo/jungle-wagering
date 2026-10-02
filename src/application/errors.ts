export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`transaction ${reference} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

export class DuplicateExternalTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_EXTERNAL_TRANSACTION';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `transaction ${externalTransactionId} of provider ${providerId} already exists under another idempotency key`,
    );
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';

  constructor() {
    super('cursor is not valid');
  }
}

export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';

  constructor(
    public readonly constraint: string,
    options?: ErrorOptions,
  ) {
    super(`unique constraint ${constraint} was violated`, options);
  }
}

export class StaleWalletVersionError extends ApplicationError {
  readonly code = 'STALE_WALLET_VERSION';

  constructor(walletId: string) {
    super(`wallet ${walletId} changed since it was loaded`);
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}
