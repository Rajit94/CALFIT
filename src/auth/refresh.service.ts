import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readNumber } from './auth-config.js';
import type { ClientDetails } from './client-info.decorator.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  isWellFormedRefreshToken,
} from './token.crypto.js';

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresAt: string;
}

const invalidToken = (): UnauthorizedException =>
  new UnauthorizedException({
    code: 'REFRESH_TOKEN_INVALID',
    message: 'Invalid refresh token. Please sign in again.',
  });

const expiredToken = (): UnauthorizedException =>
  new UnauthorizedException({
    code: 'REFRESH_TOKEN_EXPIRED',
    message: 'Your session has expired. Please sign in again.',
  });

const reusedToken = (): UnauthorizedException =>
  new UnauthorizedException({
    code: 'REFRESH_TOKEN_REUSED',
    message: 'Your session was ended for security reasons. Please sign in again.',
  });

function assertUserAllowed(status: string): void {
  if (status === 'SUSPENDED') {
    throw new ForbiddenException({
      code: 'ACCOUNT_SUSPENDED',
      message: 'This account has been suspended.',
    });
  }
  if (status === 'DELETED') {
    throw new ForbiddenException({
      code: 'ACCOUNT_DELETED',
      message: 'This account is no longer available.',
    });
  }
}

@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
  ) {
    this.accessTtlSeconds = readNumber(config, 'JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlDays = readNumber(config, 'REFRESH_TTL_DAYS');
  }

  // Swaps a refresh token for a new access token AND a new refresh token.
  // The presented refresh token stops working: each one can be used exactly once.
  async refresh(presentedToken: string, client: ClientDetails): Promise<RefreshResult> {
    // 1. Cheap format check, before touching the database.
    if (!isWellFormedRefreshToken(presentedToken)) throw invalidToken();
    const now = new Date();

    // 2. Find the session by the token's fingerprint (we never store the token itself).
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashRefreshToken(presentedToken) },
      select: {
        id: true,
        userId: true,
        deviceName: true,
        platform: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { status: true } },
      },
    });
    if (!session) throw invalidToken();

    // 3. Already used or revoked: either an app bug or a stolen token.
    if (session.revokedAt !== null) {
      // A token that is both revoked and expired is useless, so no alarm.
      if (session.expiresAt.getTime() <= now.getTime()) throw invalidToken();
      await this.handleReuse(session.id, session.userId, client);
      throw reusedToken();
    }

    // 4. Expired.
    if (session.expiresAt.getTime() <= now.getTime()) throw expiredToken();

    // 5. Suspended or deleted users cannot refresh.
    assertUserAllowed(session.user.status);

    // 6. Rotate in one transaction.
    const newToken = generateRefreshToken();
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTtlDays * 86_400_000);

    const created = await this.prisma.$transaction(async (tx) => {
      // Only succeeds if the session is still unrevoked: two simultaneous refreshes cannot both win.
      const revoked = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return null;

      return tx.session.create({
        data: {
          userId: session.userId,
          refreshTokenHash: hashRefreshToken(newToken),
          deviceName: session.deviceName,
          platform: session.platform,
          ip: client.ip ?? null,
          expiresAt: refreshExpiresAt,
        },
        select: { id: true },
      });
    });

    // 7. Lost the race: the same token was just used by another request.
    if (!created) {
      await this.handleReuse(session.id, session.userId, client);
      throw reusedToken();
    }

    // 8. Issue the new access token for the new session.
    const accessToken = await this.jwt.signAsync(
      { sub: session.userId, sid: created.id },
      { expiresIn: this.accessTtlSeconds },
    );

    return {
      accessToken,
      refreshToken: newToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  // Revoke ALL of the user's sessions and record the event. Revoking comes first and must succeed;
  // a failed audit write is logged but never changes the answer the client gets.
  private async handleReuse(
    sessionId: string,
    userId: string,
    client: ClientDetails,
  ): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'auth.refresh_reuse_detected',
          entityType: 'session',
          entityId: sessionId,
          metadata: { revokedSessions: result.count },
          ip: client.ip ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        'Could not write the audit entry for refresh token reuse',
        error instanceof Error ? error.stack : String(error),
      );
    }

    this.logger.warn(
      `Refresh token reuse detected: user=${userId} session=${sessionId} revoked=${result.count}`,
    );
  }
}