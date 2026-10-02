// Issues real signed tokens for tests, playing the part of the identity provider: one key
// pair the adapter trusts and one it does not, so signature checks are exercised for real.
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';

export const TEST_ISSUER = 'http://identity.test/realms/wagering';
export const TEST_AUDIENCE = 'wagering-api';

export interface TokenOptions {
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  signedByStranger?: boolean;
}

export async function createTokenIssuer() {
  const trusted = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(trusted.publicKey)), kid: 'trusted', alg: 'RS256' };
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    sign(claims: JWTPayload, options: TokenOptions = {}): Promise<string> {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'trusted' })
        .setIssuer(options.issuer ?? TEST_ISSUER)
        .setAudience(options.audience ?? TEST_AUDIENCE)
        .setIssuedAt(nowSeconds() - 120)
        .setExpirationTime(options.expiresAt ?? nowSeconds() + 300)
        .sign(options.signedByStranger ? stranger.privateKey : trusted.privateKey);
    },
    nowSeconds,
  };
}

export type TokenIssuer = Awaited<ReturnType<typeof createTokenIssuer>>;
