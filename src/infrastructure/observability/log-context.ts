// Carries correlation fields through one execution (an HTTP request, an SQS message, a
// worker tick) without passing them through every function. Each execution gets its own
// store, so concurrent requests never see each other's fields.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogFields } from '../../application/ports/logger';

const storage = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, work: () => T): T {
  return storage.run({ ...fields }, work);
}

export function addLogContext(fields: LogFields): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}
