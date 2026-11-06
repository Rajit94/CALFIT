import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Put @Public() on a controller or a route that must be reachable without signing in.
// Every route without it is protected by JwtAuthGuard.
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);