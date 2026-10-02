// Keeps the EntityManager of the current transaction in AsyncLocalStorage so repositories
// use it without receiving it as a parameter. Driver errors leave here already translated:
// callers only ever see application errors.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  ApplicationError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../application/errors';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { DomainError } from '../../domain/shared/domain-error';

interface ActiveContext {
  em: EntityManager;
  transactional: boolean;
}

const UNIQUE_VIOLATION = '23505';

const TRANSIENT_CODES = new Set([
  '55P03',
  '40P01',
  '40001',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function constraintName(error: unknown): string {
  const direct = (error as { constraint?: unknown } | null)?.constraint;
  if (typeof direct === 'string') {
    return direct;
  }
  const match = /constraint "([^"]+)"/.exec(error instanceof Error ? error.message : '');
  return match?.[1] ?? 'unknown';
}

export function translateDriverError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError) {
    return error;
  }
  const code = errorCode(error);
  if (code === UNIQUE_VIOLATION) {
    return new UniqueViolationError(constraintName(error), { cause: error });
  }
  const timedOutWaitingForPool = error instanceof Error && error.name === 'KnexTimeoutError';
  if ((code !== undefined && TRANSIENT_CODES.has(code)) || timedOutWaitingForPool) {
    return new TransientInfrastructureError('database is temporarily unavailable', {
      cause: error,
    });
  }
  return error;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly active = new AsyncLocalStorage<ActiveContext>();

  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
      throw new Error('lockTimeoutMs must be a positive integer');
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active.getStore()?.transactional) {
      return work();
    }
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        return this.active.run({ em, transactional: true }, work);
      });
    } catch (error) {
      throw translateDriverError(error);
    }
  }

  async read<T>(work: () => Promise<T>): Promise<T> {
    if (this.active.getStore()) {
      return work();
    }
    try {
      return await this.active.run({ em: this.orm.em.fork(), transactional: false }, work);
    } catch (error) {
      throw translateDriverError(error);
    }
  }

  em(): EntityManager {
    const context = this.active.getStore();
    if (!context) {
      throw new Error('repository used outside a unit of work: wrap the call in run() or read()');
    }
    return context.em;
  }
}
