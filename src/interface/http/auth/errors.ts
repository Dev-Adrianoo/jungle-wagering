export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'PROVIDER_MISMATCH';

export class HttpAuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpAuthError';
  }
}
