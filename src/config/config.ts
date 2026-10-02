import { z } from 'zod';

const fifoQueueName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'must be a FIFO queue name ending in .fifo');

const schema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    LOCK_TIMEOUT_MS: z.coerce.number().int().min(50).max(60000).default(3000),
    AUTH_MODE: z.enum(['noop', 'oidc']).default('noop'),
    OIDC_ISSUER: z.string().min(1).optional(),
    OIDC_JWKS_URL: z.string().url().optional(),
    OIDC_AUDIENCE: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    SQS_ENDPOINT: z.string().url().optional(),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    SQS_TRANSACTIONS_QUEUE: fifoQueueName.default('wager-transactions.fifo'),
    SQS_DLQ_QUEUE: fifoQueueName.default('wager-transactions-dlq.fifo'),
    SQS_EVENTS_QUEUE: fifoQueueName.default('wager-events.fifo'),
    WORKERS_ENABLED: z.enum(['true', 'false']).default('true'),
    SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(5),
    FAULT_CRASH_AT: z.string().min(1).optional(),
  })
  .superRefine((env, context) => {
    if (env.AUTH_MODE !== 'oidc') {
      return;
    }
    for (const name of ['OIDC_ISSUER', 'OIDC_JWKS_URL', 'OIDC_AUDIENCE'] as const) {
      if (env[name] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'is required when AUTH_MODE=oidc',
        });
      }
    }
  });

export interface SqsConfig {
  endpoint: string | undefined;
  region: string;
  transactionsQueue: string;
  deadLetterQueue: string;
  eventsQueue: string;
}

export interface OidcConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  lockTimeoutMs: number;
  authMode: 'noop' | 'oidc';
  oidc?: OidcConfig;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  workersEnabled: boolean;
  sqsWaitTimeSeconds: number;
  crashAt: string | undefined;
  sqs: SqsConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  const { OIDC_ISSUER, OIDC_JWKS_URL, OIDC_AUDIENCE } = parsed.data;
  const oidc =
    parsed.data.AUTH_MODE === 'oidc' && OIDC_ISSUER && OIDC_JWKS_URL && OIDC_AUDIENCE
      ? { issuer: OIDC_ISSUER, jwksUrl: OIDC_JWKS_URL, audience: OIDC_AUDIENCE }
      : undefined;
  return {
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    lockTimeoutMs: parsed.data.LOCK_TIMEOUT_MS,
    authMode: parsed.data.AUTH_MODE,
    ...(oidc === undefined ? {} : { oidc }),
    logLevel: parsed.data.LOG_LEVEL,
    workersEnabled: parsed.data.WORKERS_ENABLED === 'true',
    sqsWaitTimeSeconds: parsed.data.SQS_WAIT_TIME_SECONDS,
    crashAt: parsed.data.FAULT_CRASH_AT,
    sqs: {
      endpoint: parsed.data.SQS_ENDPOINT,
      region: parsed.data.AWS_REGION,
      transactionsQueue: parsed.data.SQS_TRANSACTIONS_QUEUE,
      deadLetterQueue: parsed.data.SQS_DLQ_QUEUE,
      eventsQueue: parsed.data.SQS_EVENTS_QUEUE,
    },
  };
}
