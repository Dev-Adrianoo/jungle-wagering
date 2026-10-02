// Deny by default: a route that is neither @Public() nor @Roles(...) is refused. An
// identity bound to a provider may only act on that provider: the providerId in the body
// or in the route has to match it.
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type {
  Identity,
  ProviderIdentityPort,
  Role,
} from '../../../application/ports/provider-identity-port';
import { PROVIDER_IDENTITY_PORT } from '../tokens';
import { PUBLIC_KEY, ROLES_KEY } from './decorators';
import { HttpAuthError } from './errors';

function claimedProviderIds(request: Request): string[] {
  const fromRoute = (request.params as Record<string, unknown> | undefined)?.providerId;
  const fromBody = (request.body as Record<string, unknown> | undefined)?.providerId;
  return [fromRoute, fromBody].filter((value): value is string => typeof value === 'string');
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { identity?: Identity }>();
    const identity = await this.identities.identify(request.headers);
    if (!identity) {
      throw new HttpAuthError('UNAUTHENTICATED', 'authentication is required');
    }

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? [];
    if (!allowed.some((role) => identity.roles.includes(role))) {
      throw new HttpAuthError('FORBIDDEN', 'the identity does not have a role allowed here');
    }

    const boundProvider = identity.providerId;
    if (
      boundProvider !== undefined &&
      claimedProviderIds(request).some((claimed) => claimed !== boundProvider)
    ) {
      throw new HttpAuthError('PROVIDER_MISMATCH', 'the identity belongs to another provider');
    }

    request.identity = identity;
    return true;
  }
}
