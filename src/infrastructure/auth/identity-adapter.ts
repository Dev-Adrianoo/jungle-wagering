// Chooses the identity adapter from configuration. The key set is fetched over HTTP on the
// first token and cached by jose; the timeout keeps a slow identity provider from holding a
// request for long.
import { createRemoteJWKSet } from 'jose';
import type { ProviderIdentityPort } from '../../application/ports/provider-identity-port';
import type { AppConfig } from '../../config/config';
import { NoopIdentityAdapter } from './noop-identity-adapter';
import { OidcIdentityAdapter } from './oidc-identity-adapter';

const KEY_SET_TIMEOUT_MS = 2000;

export function identityAdapterFor(
  config: Pick<AppConfig, 'authMode' | 'oidc'>,
): ProviderIdentityPort {
  if (config.authMode !== 'oidc') {
    return new NoopIdentityAdapter();
  }
  if (!config.oidc) {
    throw new Error('AUTH_MODE=oidc requires the OIDC settings');
  }
  return new OidcIdentityAdapter({
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    keys: createRemoteJWKSet(new URL(config.oidc.jwksUrl), {
      timeoutDuration: KEY_SET_TIMEOUT_MS,
    }),
  });
}
