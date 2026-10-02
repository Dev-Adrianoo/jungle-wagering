// Extension point for authentication. The challenge does not score authentication, so the
// default adapter grants every role. A real adapter validates a token issued by an external
// identity provider (OIDC) and maps its claims to an Identity.
export type Role = 'provider' | 'operator' | 'auditor';

export interface Identity {
  subject: string;
  roles: readonly Role[];
  providerId: string | undefined;
}

export type RequestHeaders = Record<string, string | string[] | undefined>;

export interface ProviderIdentityPort {
  identify(headers: RequestHeaders): Promise<Identity | undefined>;
}
