import pino, { type DestinationStream, type Logger as PinoInstance } from 'pino';
import type { LogFields, Logger } from '../../application/ports/logger';
import { currentLogContext } from './log-context';

function withoutUndefined(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export class PinoLogger implements Logger {
  private readonly pino: PinoInstance;

  constructor(level: string, destination?: DestinationStream) {
    this.pino = pino(
      {
        level,
        base: undefined,
        messageKey: 'event',
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
      },
      destination,
    );
  }

  info(event: string, fields: LogFields = {}): void {
    this.pino.info(this.merged(fields), event);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.pino.warn(this.merged(fields), event);
  }

  error(event: string, fields: LogFields = {}): void {
    this.pino.error(this.merged(fields), event);
  }

  private merged(fields: LogFields): LogFields {
    return withoutUndefined({ ...currentLogContext(), ...fields });
  }
}
