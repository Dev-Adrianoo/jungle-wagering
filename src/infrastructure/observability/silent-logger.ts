import type { Logger } from '../../application/ports/logger';

export class SilentLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}
