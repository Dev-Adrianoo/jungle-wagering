// Every request gets one correlation id: the caller's X-Correlation-Id when it is well
// formed, otherwise a new one. It is echoed in the response, stored on the transaction and
// copied to the events, so one id follows a request through HTTP, database and messaging.
import { randomUUID } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { safely } from '../../application/observability/safely';
import type { Logger } from '../../application/ports/logger';
import { runWithLogContext } from '../../infrastructure/observability/log-context';

const HEADER = 'x-correlation-id';
const WELL_FORMED = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelatedRequest extends Request {
  correlationId?: string;
}

export function correlationMiddleware(logger: Logger) {
  return (request: CorrelatedRequest, response: Response, next: NextFunction): void => {
    const received = request.header(HEADER);
    const correlationId = received && WELL_FORMED.test(received) ? received : randomUUID();
    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);
    const startedAt = performance.now();
    runWithLogContext({ correlationId }, () => {
      response.on('finish', () => {
        safely(() =>
          logger.info('http.request', {
            correlationId,
            method: request.method,
            path: request.path,
            status: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          }),
        );
      });
      next();
    });
  };
}

export function correlationIdOf(request: CorrelatedRequest): string {
  return request.correlationId ?? 'unknown';
}

export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    correlationIdOf(context.switchToHttp().getRequest<CorrelatedRequest>()),
);
