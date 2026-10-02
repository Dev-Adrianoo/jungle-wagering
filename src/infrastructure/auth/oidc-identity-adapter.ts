// Validates a bearer token issued by an OIDC provider (Keycloak) against the keys the
// provider publishes. A token that does not verify means "no identity" (401). Keys that
// cannot be fetched are a transient failure (503): with the identity provider down, letting
// the request through and refusing a valid caller for good would both be wrong answers.
import { errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { ApplicationError } from '../../application/errors';
import type {
  Identity,
  ProviderIdentityPort,
  RequestHeaders,
  Role,
} from '../../application/ports/provider-identity-port';

const BEARER = 'Bearer ';
const KNOWN_ROLES: readonly Role[] = ['provider', 'operator', 'auditor'];
const GENERIC_JOSE_FAILURE = 'ERR_JOSE_GENERIC';

export interface OidcIdentityOptions {
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
}

export class IdentityProviderUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';

  constructor() {
    super('the identity provider keys could not be fetched');
  }
}

// jose reports a rejected token with a specific error class. What is left is the key set
// itself failing: a timeout, a response that is not 200 (reported with the generic code) or
// a network error, which is not a jose error at all.
function keysWereUnreachable(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) {
    return true;
  }
  return error instanceof errors.JWKSTimeout || error.code === GENERIC_JOSE_FAILURE;
}

function bearerTokenOf(headers: RequestHeaders): string | undefined {
  const header = headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  return value?.startsWith(BEARER) ? value.slice(BEARER.length) : undefined;
}

export class OidcIdentityAdapter implements ProviderIdentityPort {
  constructor(private readonly options: OidcIdentityOptions) {}

  async identify(headers: RequestHeaders): Promise<Identity | undefined> {
    const token = bearerTokenOf(headers);
    if (token === undefined) {
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(token, this.options.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        requiredClaims: ['sub', 'exp'],
      });
      const granted = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
      return {
        subject: payload.sub as string,
        roles: KNOWN_ROLES.filter((role) => Array.isArray(granted) && granted.includes(role)),
        providerId: typeof payload.provider_id === 'string' ? payload.provider_id : undefined,
      };
    } catch (error) {
      if (keysWereUnreachable(error)) {
        throw new IdentityProviderUnavailableError();
      }
      return undefined;
    }
  }
}
