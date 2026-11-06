import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { extractBearerToken } from './bearer-token.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

interface AccessTokenClaims {
  sub?: unknown; // user id
  sid?: unknown; // session id
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unauthorized = (code: string, message: string): UnauthorizedException =>
  new UnauthorizedException({ code, message });

// Protects every route unless it is marked @Public(). It is written for HTTP only;
// WebSocket gateways (Phase 2) will need their own guard.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Routes marked @Public() need no token.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // 2. Read the token from "Authorization: Bearer <token>".
    const bearer = extractBearerToken(request.headers.authorization);
    if (bearer.status === 'missing') {
      throw unauthorized('TOKEN_MISSING', 'Authentication required.');
    }
    if (bearer.status === 'malformed') {
      throw unauthorized('TOKEN_INVALID', 'Invalid authentication token.');
    }

    // 3. Check the signature (HS256 only) and the expiry.
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(bearer.token, { algorithms: ['HS256'] });
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw unauthorized('TOKEN_EXPIRED', 'The access token has expired.');
      }
      throw unauthorized('TOKEN_INVALID', 'Invalid authentication token.');
    }

    // 4. The token must carry a user id and a session id in the expected format.
    if (typeof payload !== 'object' || payload === null) {
      throw unauthorized('TOKEN_INVALID', 'Invalid authentication token.');
    }
    const { sub, sid } = payload as AccessTokenClaims;
    if (typeof sub !== 'string' || typeof sid !== 'string' || !UUID.test(sub) || !UUID.test(sid)) {
      throw unauthorized('TOKEN_INVALID', 'Invalid authentication token.');
    }

    // 5. One database lookup: is the session still valid, and is the user allowed in?
    const session = await this.prisma.session.findUnique({
      where: { id: sid },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { status: true } },
      },
    });
    if (!session || session.userId !== sub) {
      throw unauthorized('SESSION_INVALID', 'This session is no longer valid.');
    }
    if (session.revokedAt !== null) {
      throw unauthorized('SESSION_REVOKED', 'This session has been signed out.');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw unauthorized('SESSION_INVALID', 'This session has expired. Please sign in again.');
    }

    // 6. Suspended or deleted users cannot use the API.
    if (session.user.status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account has been suspended.',
      });
    }
    if (session.user.status === 'DELETED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_DELETED',
        message: 'This account is no longer available.',
      });
    }

    // 7. Success: expose who is calling, for @CurrentUser().
    request.user = { id: session.userId, sessionId: session.id };
    return true;
  }
}