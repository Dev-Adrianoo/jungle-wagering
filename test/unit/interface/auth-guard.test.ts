import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Identity, Role } from '../../../src/application/ports/provider-identity-port';
import { NoopIdentityAdapter } from '../../../src/infrastructure/auth/noop-identity-adapter';
import { AuthGuard } from '../../../src/interface/http/auth/auth.guard';
import { PUBLIC_KEY, ROLES_KEY } from '../../../src/interface/http/auth/decorators';
import { HttpAuthError } from '../../../src/interface/http/auth/errors';

class Route {
  handler() {}
}

function contextFor(
  request: object,
  metadata: { public?: boolean; roles?: Role[] } = {},
): ExecutionContext {
  if (metadata.public) {
    Reflect.defineMetadata(PUBLIC_KEY, true, Route.prototype.handler);
  } else {
    Reflect.deleteMetadata(PUBLIC_KEY, Route.prototype.handler);
  }
  if (metadata.roles) {
    Reflect.defineMetadata(ROLES_KEY, metadata.roles, Route.prototype.handler);
  } else {
    Reflect.deleteMetadata(ROLES_KEY, Route.prototype.handler);
  }
  return {
    getHandler: () => Route.prototype.handler,
    getClass: () => Route,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const guardFor = (identity: Identity | undefined) =>
  new AuthGuard(new Reflector(), { identify: async () => identity });

const operator: Identity = { subject: 'op', roles: ['operator'], providerId: undefined };
const boundProvider: Identity = { subject: 'p', roles: ['provider'], providerId: 'provider-a' };

async function refusalOf(work: Promise<unknown>): Promise<HttpAuthError> {
  try {
    await work;
  } catch (error) {
    return error as HttpAuthError;
  }
  throw new Error('expected the guard to refuse');
}

describe('AuthGuard', () => {
  test('a public route needs no identity', async () => {
    const guard = guardFor(undefined);

    expect(await guard.canActivate(contextFor({ headers: {} }, { public: true }))).toBe(true);
  });

  test('no identity is UNAUTHENTICATED', async () => {
    const error = await refusalOf(
      guardFor(undefined).canActivate(contextFor({ headers: {} }, { roles: ['operator'] })),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
  });

  test('a route without roles is refused for any identity', async () => {
    const error = await refusalOf(guardFor(operator).canActivate(contextFor({ headers: {} })));

    expect(error.code).toBe('FORBIDDEN');
  });

  test('one matching role is enough', async () => {
    const request = { headers: {} };
    const context = contextFor(request, { roles: ['auditor', 'operator'] });

    expect(await guardFor(operator).canActivate(context)).toBe(true);
  });

  test('a role that is not allowed is FORBIDDEN', async () => {
    const error = await refusalOf(
      guardFor(operator).canActivate(contextFor({ headers: {} }, { roles: ['provider'] })),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  test('the identity is attached to the request for later handlers', async () => {
    const request: { headers: object; identity?: Identity } = { headers: {} };

    await guardFor(operator).canActivate(contextFor(request, { roles: ['operator'] }));

    expect(request.identity).toEqual(operator);
  });

  test('an identity bound to a provider cannot claim another one in the route or the body', async () => {
    const roles: Role[] = ['provider'];
    const inRoute = { headers: {}, params: { providerId: 'provider-b' } };
    const inBody = { headers: {}, body: { providerId: 'provider-b' } };

    for (const request of [inRoute, inBody]) {
      const error = await refusalOf(
        guardFor(boundProvider).canActivate(contextFor(request, { roles })),
      );
      expect(error.code).toBe('PROVIDER_MISMATCH');
    }
  });

  test('a single mismatching claim is enough to refuse, even beside a matching one', async () => {
    const request = {
      headers: {},
      params: { providerId: 'provider-a' },
      body: { providerId: 'provider-b' },
    };

    const error = await refusalOf(
      guardFor(boundProvider).canActivate(contextFor(request, { roles: ['provider'] })),
    );

    expect(error.code).toBe('PROVIDER_MISMATCH');
  });

  test('a bound identity acting on its own provider, or on none, passes', async () => {
    const roles: Role[] = ['provider'];
    const own = { headers: {}, params: { providerId: 'provider-a' } };
    const none = { headers: {} };

    expect(await guardFor(boundProvider).canActivate(contextFor(own, { roles }))).toBe(true);
    expect(await guardFor(boundProvider).canActivate(contextFor(none, { roles }))).toBe(true);
  });

  test('an unbound identity may act on any provider', async () => {
    const request = { headers: {}, params: { providerId: 'provider-z' } };

    expect(await guardFor(operator).canActivate(contextFor(request, { roles: ['operator'] }))).toBe(
      true,
    );
  });
});

describe('NoopIdentityAdapter', () => {
  test('lets every role through and is bound to no provider', async () => {
    const identity = await new NoopIdentityAdapter().identify();

    expect([...identity.roles].sort()).toEqual(['auditor', 'operator', 'provider']);
    expect(identity.providerId).toBeUndefined();
  });
});
