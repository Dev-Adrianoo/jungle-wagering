import type {
  Identity,
  ProviderIdentityPort,
  RequestHeaders,
  Role,
} from '../../src/application/ports/provider-identity-port';

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export class FakeIdentityAdapter implements ProviderIdentityPort {
  async identify(headers: RequestHeaders): Promise<Identity | undefined> {
    const subject = single(headers['x-test-subject']);
    if (!subject) {
      return undefined;
    }
    const roles = (single(headers['x-test-roles']) ?? '').split(',').filter(Boolean) as Role[];
    return { subject, roles, providerId: single(headers['x-test-provider']) };
  }
}

export const as = (roles: string, providerId?: string): Record<string, string> => ({
  'x-test-subject': 'tester',
  'x-test-roles': roles,
  ...(providerId === undefined ? {} : { 'x-test-provider': providerId }),
});
