import type {
  Identity,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity-port';

const EVERY_ROLE: Identity = {
  subject: 'anonymous',
  roles: ['provider', 'operator', 'auditor'],
  providerId: undefined,
};

export class NoopIdentityAdapter implements ProviderIdentityPort {
  async identify(): Promise<Identity> {
    return EVERY_ROLE;
  }
}
