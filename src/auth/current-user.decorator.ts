import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser } from './auth.types.js';

// Plain function so it can be unit-tested without a running server.
export function requireAuthUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) {
    throw new UnauthorizedException({
      code: 'TOKEN_MISSING',
      message: 'Authentication required.',
    });
  }
  return request.user;
}

// Usage in a controller:  me(@CurrentUser() user: AuthUser) { ... }
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    requireAuthUser(ctx.switchToHttp().getRequest<AuthenticatedRequest>()),
);