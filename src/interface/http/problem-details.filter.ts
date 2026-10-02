// Maps every error to one HTTP status and one machine-readable code, in a single table,
// so a provider can decide to resend, fix the payload or give up without parsing messages:
// 400 invalid request, 409 conflict, 422 business rejection (returned by the controller,
// not here), 503 transient failure, 500 a bug on our side.
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { RequestValidationError, type ValidationIssue } from '../contracts/parse';
import { type CorrelatedRequest, correlationIdOf } from './correlation';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  errors?: ValidationIssue[];
}

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_MISSING: 400,
  INVALID_MONEY: 400,
  INVALID_WAGER_TRANSACTION: 400,
  NEGATIVE_INITIAL_BALANCE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  PROVIDER_MISMATCH: 403,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  DUPLICATE_EXTERNAL_TRANSACTION: 409,
  SERVICE_UNAVAILABLE: 503,
  STALE_WALLET_VERSION: 503,
  UNIQUE_VIOLATION: 503,
};

const CODE_BY_HTTP_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

const TITLE_BY_STATUS: Record<number, string> = {
  400: 'Invalid request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  500: 'Internal error',
  503: 'Service temporarily unavailable',
};

function problem(
  status: number,
  code: string,
  detail: string,
  errors?: ValidationIssue[],
): ProblemDetails {
  return {
    type: `urn:wagering:problem:${code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLE_BY_STATUS[status] ?? 'Request failed',
    status,
    code,
    detail,
    ...(errors === undefined ? {} : { errors }),
  };
}

const INTERNAL = problem(500, 'INTERNAL_ERROR', 'an unexpected error occurred');

function codeOf(exception: unknown): string | undefined {
  const code = (exception as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function toProblem(exception: unknown): ProblemDetails {
  if (exception instanceof RequestValidationError) {
    return problem(400, exception.code, exception.message, exception.issues);
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return problem(
      status,
      CODE_BY_HTTP_STATUS[status] ?? 'HTTP_ERROR',
      TITLE_BY_STATUS[status] ?? 'Request failed',
    );
  }
  const code = codeOf(exception);
  const status = code === undefined ? undefined : STATUS_BY_CODE[code];
  if (code === undefined || status === undefined || !(exception instanceof Error)) {
    return INTERNAL;
  }
  if (status === 503) {
    return problem(
      503,
      'SERVICE_UNAVAILABLE',
      'the service is temporarily unavailable, retry later',
    );
  }
  return problem(status, code, exception.message);
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const correlationId = correlationIdOf(http.getRequest<CorrelatedRequest>());
    const body = toProblem(exception);

    if (body.status >= 500) {
      const name = exception instanceof Error ? exception.name : typeof exception;
      const message = exception instanceof Error ? exception.message : String(exception);
      console.error(JSON.stringify({ level: 'error', correlationId, error: name, message }));
    }
    if (body.status === 503) {
      response.setHeader('Retry-After', '1');
    }
    response
      .status(body.status)
      .type('application/problem+json')
      .send(JSON.stringify({ ...body, correlationId }));
  }
}
