import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  LOCK_TIMEOUT_MS: z.coerce.number().int().min(50).max(60000).default(3000),
  AUTH_MODE: z.enum(['noop']).default('noop'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  lockTimeoutMs: number;
  authMode: 'noop';
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
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
  };
}
