import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../../application/ports/provider-identity-port';

export const PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';

export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
