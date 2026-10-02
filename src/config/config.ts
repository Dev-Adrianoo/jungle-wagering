import { z } from 'zod';

const fifoQueueName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'must be a FIFO queue name ending in .fifo');

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(50).max(60000).default(3000),
  AUTH_MODE: z.enum(['noop']).default('noop'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  SQS_ENDPOINT: z.string().url().optional(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  SQS_TRANSACTIONS_QUEUE: fifoQueueName.default('wager-transactions.fifo'),
  SQS_DLQ_QUEUE: fifoQueueName.default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: fifoQueueName.default('wager-events.fifo'),
});

export interface SqsConfig {
  endpoint: string | undefined;
  region: string;
  transactionsQueue: string;
  deadLetterQueue: string;
  eventsQueue: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  lockTimeoutMs: number;
  authMode: 'noop';
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
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
  return {
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    lockTimeoutMs: parsed.data.LOCK_TIMEOUT_MS,
    authMode: parsed.data.AUTH_MODE,
    logLevel: parsed.data.LOG_LEVEL,
    sqs: {
      endpoint: parsed.data.SQS_ENDPOINT,
      region: parsed.data.AWS_REGION,
      transactionsQueue: parsed.data.SQS_TRANSACTIONS_QUEUE,
      deadLetterQueue: parsed.data.SQS_DLQ_QUEUE,
      eventsQueue: parsed.data.SQS_EVENTS_QUEUE,
    },
  };
}
