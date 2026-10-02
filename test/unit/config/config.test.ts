import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../../src/config/config';

describe('loadConfig', () => {
  test('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5440/db' })).toEqual({
      port: 3000,
      databaseUrl: 'postgres://u:p@localhost:5440/db',
      lockTimeoutMs: 3000,
      authMode: 'noop',
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
});
