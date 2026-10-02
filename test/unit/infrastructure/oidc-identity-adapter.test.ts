import { beforeAll, describe, expect, test } from 'bun:test';
import { createRemoteJWKSet, errors } from 'jose';
import {
  IdentityProviderUnavailableError,
  OidcIdentityAdapter,
} from '../../../src/infrastructure/auth/oidc-identity-adapter';
import {
  createTokenIssuer,
  TEST_AUDIENCE,
  TEST_ISSUER,
  type TokenIssuer,
} from '../../support/oidc-tokens';
import { rejectionOf } from '../../support/rejection';

let issuer: TokenIssuer;
let adapter: OidcIdentityAdapter;

beforeAll(async () => {
  issuer = await createTokenIssuer();
  adapter = new OidcIdentityAdapter({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    keys: issuer.keys,
  });
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('OidcIdentityAdapter with a valid token', () => {
  test('maps subject, known roles and the provider claim to an identity', async () => {
    const token = await issuer.sign({
      sub: 'service-account-provider-a',
      realm_access: { roles: ['provider', 'offline_access', 'default-roles-wagering'] },
      provider_id: 'provider-a',
    });

    expect(await adapter.identify(bearer(token))).toEqual({
      subject: 'service-account-provider-a',
      roles: ['provider'],
      providerId: 'provider-a',
    });
  });

  test('an identity without the provider claim is not bound to a provider', async () => {
    const token = await issuer.sign({
      sub: 'operator-1',
      realm_access: { roles: ['operator', 'auditor'] },
    });

    expect(await adapter.identify(bearer(token))).toEqual({
      subject: 'operator-1',
      roles: ['operator', 'auditor'],
      providerId: undefined,
    });
  });

  test('a token without roles is an identity with no role', async () => {
    const token = await issuer.sign({ sub: 'nobody' });

    expect(await adapter.identify(bearer(token))).toEqual({
      subject: 'nobody',
      roles: [],
      providerId: undefined,
    });
  });

  test('the header is read when it arrives as a list', async () => {
    const token = await issuer.sign({ sub: 'listed', realm_access: { roles: ['auditor'] } });

    const identity = await adapter.identify({ authorization: [`Bearer ${token}`] });

    expect(identity?.subject).toBe('listed');
  });
});

describe('OidcIdentityAdapter refusing', () => {
  test('no Authorization header is no identity', async () => {
    expect(await adapter.identify({})).toBeUndefined();
  });

  test('a scheme other than Bearer is no identity', async () => {
    const token = await issuer.sign({ sub: 'x' });

    expect(await adapter.identify({ authorization: `Basic ${token}` })).toBeUndefined();
  });

  test('text that is not a token is no identity', async () => {
    expect(await adapter.identify(bearer('not-a-token'))).toBeUndefined();
  });

  test('an expired token is no identity', async () => {
    const token = await issuer.sign({ sub: 'x' }, { expiresAt: issuer.nowSeconds() - 60 });

    expect(await adapter.identify(bearer(token))).toBeUndefined();
  });

  test('a token from another issuer is no identity', async () => {
    const token = await issuer.sign({ sub: 'x' }, { issuer: 'http://elsewhere.test/realms/x' });

    expect(await adapter.identify(bearer(token))).toBeUndefined();
  });

  test('a token for another audience is no identity', async () => {
    const token = await issuer.sign({ sub: 'x' }, { audience: 'another-api' });

    expect(await adapter.identify(bearer(token))).toBeUndefined();
  });

  test('a token signed by a key the provider does not publish is no identity', async () => {
    const token = await issuer.sign({ sub: 'x' }, { signedByStranger: true });

    expect(await adapter.identify(bearer(token))).toBeUndefined();
  });

  test('a token without a subject is no identity', async () => {
    const token = await issuer.sign({ realm_access: { roles: ['provider'] } });

    expect(await adapter.identify(bearer(token))).toBeUndefined();
  });
});

describe('OidcIdentityAdapter when the keys cannot be fetched', () => {
  const failingWith = (failure: unknown) =>
    new OidcIdentityAdapter({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      keys: async () => {
        throw failure;
      },
    });

  test('a timeout is a transient failure, not a refusal', async () => {
    const token = await issuer.sign({ sub: 'x' });

    const error = await rejectionOf(failingWith(new errors.JWKSTimeout()).identify(bearer(token)));

    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
    expect((error as IdentityProviderUnavailableError).code).toBe('SERVICE_UNAVAILABLE');
  });

  test('a network error is a transient failure', async () => {
    const token = await issuer.sign({ sub: 'x' });

    const error = await rejectionOf(
      failingWith(new TypeError('fetch failed')).identify(bearer(token)),
    );

    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
  });

  test('an identity provider that is down is a transient failure', async () => {
    const token = await issuer.sign({ sub: 'x' });
    const unreachable = new OidcIdentityAdapter({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      keys: createRemoteJWKSet(new URL('http://127.0.0.1:9/certs'), { timeoutDuration: 1000 }),
    });

    const error = await rejectionOf(unreachable.identify(bearer(token)));

    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
  });

  test('without a token the keys are never consulted', async () => {
    expect(await failingWith(new errors.JWKSTimeout()).identify({})).toBeUndefined();
  });
});
