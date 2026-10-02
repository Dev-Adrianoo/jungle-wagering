import type { z } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RequestValidationError extends Error {
  constructor(
    public readonly issues: ValidationIssue[],
    public readonly code = 'VALIDATION_ERROR',
  ) {
    super('the request is not valid');
    this.name = 'RequestValidationError';
  }
}

// Issues carry the path and the rule that failed, never the received value:
// request bodies hold financial data and must not leak into responses or logs.
export function parseWith<T>(schema: z.ZodType<T>, input: unknown, code?: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    throw new RequestValidationError(issues, code);
  }
  return result.data;
}
