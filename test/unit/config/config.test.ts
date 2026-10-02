import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../../src/config/config';

describe('loadConfig', () => {
  test('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5440/db' })).toEqual({
      port: 3000,
      databaseUrl: 'postgres://u:p@localhost:5440/db',
      lockTimeoutMs: 3000,
      authMode: 'noop',
      logLevel: 'info',
      workersEnabled: true,
      sqsWaitTimeSeconds: 5,
      crashAt: undefined,
      sqs: {
        endpoint: undefined,
        region: 'us-east-1',
        transactionsQueue: 'wager-transactions.fifo',
        deadLetterQueue: 'wager-transactions-dlq.fifo',
        eventsQueue: 'wager-events.fifo',
      },
    });
  });

  test('reads overrides', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost:5440/db',
      PORT: '3001',
      LOCK_TIMEOUT_MS: '500',
    });

    expect(config.port).toBe(3001);
    expect(config.lockTimeoutMs).toBe(500);
  });

  test('fails fast, naming the variable, when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  test('rejects a non-numeric port', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', PORT: 'abc' })).toThrow(/PORT/);
  });

  test('reads the SQS settings with their defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'x' });

    expect(config.sqs).toEqual({
      endpoint: undefined,
      region: 'us-east-1',
      transactionsQueue: 'wager-transactions.fifo',
      deadLetterQueue: 'wager-transactions-dlq.fifo',
      eventsQueue: 'wager-events.fifo',
    });
    expect(config.logLevel).toBe('info');
  });

  test('refuses a queue name that is not FIFO', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', SQS_EVENTS_QUEUE: 'wager-events' })).toThrow(
      /SQS_EVENTS_QUEUE/,
    );
  });

  test('workers are enabled by default and can be switched off', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).workersEnabled).toBe(true);
    expect(loadConfig({ DATABASE_URL: 'x', WORKERS_ENABLED: 'false' }).workersEnabled).toBe(false);
    expect(() => loadConfig({ DATABASE_URL: 'x', WORKERS_ENABLED: 'maybe' })).toThrow(
      /WORKERS_ENABLED/,
    );
  });

  test('reads the long-poll wait and the fault injection point', () => {
    const config = loadConfig({
      DATABASE_URL: 'x',
      SQS_WAIT_TIME_SECONDS: '1',
      FAULT_CRASH_AT: 'consumer.after-commit-before-ack',
    });

    expect(config.sqsWaitTimeSeconds).toBe(1);
    expect(config.crashAt).toBe('consumer.after-commit-before-ack');
    expect(loadConfig({ DATABASE_URL: 'x' }).crashAt).toBeUndefined();
  });

  test('refuses a long-poll wait outside 0 to 20 seconds', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', SQS_WAIT_TIME_SECONDS: '21' })).toThrow(
      /SQS_WAIT_TIME_SECONDS/,
    );
  });

  test('OIDC mode needs issuer, key set URL and audience', () => {
    const oidc = {
      DATABASE_URL: 'x',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'http://keycloak:8080/realms/wagering',
      OIDC_JWKS_URL: 'http://keycloak:8080/realms/wagering/protocol/openid-connect/certs',
      OIDC_AUDIENCE: 'wagering-api',
    };

    const config = loadConfig(oidc);

    expect(config.authMode).toBe('oidc');
    expect(config.oidc).toEqual({
      issuer: 'http://keycloak:8080/realms/wagering',
      jwksUrl: 'http://keycloak:8080/realms/wagering/protocol/openid-connect/certs',
      audience: 'wagering-api',
    });
    for (const missing of ['OIDC_ISSUER', 'OIDC_JWKS_URL', 'OIDC_AUDIENCE']) {
      expect(() => loadConfig({ ...oidc, [missing]: undefined })).toThrow(new RegExp(missing));
    }
  });

  test('without OIDC mode the OIDC settings are not required and not exposed', () => {
    expect(loadConfig({ DATABASE_URL: 'x' }).oidc).toBeUndefined();
    expect(loadConfig({ DATABASE_URL: 'x', OIDC_ISSUER: 'http://ignored' }).oidc).toBeUndefined();
    expect(() => loadConfig({ DATABASE_URL: 'x', AUTH_MODE: 'password' })).toThrow(/AUTH_MODE/);
  });
});
