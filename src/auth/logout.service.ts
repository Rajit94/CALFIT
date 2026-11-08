import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  isWellFormedRefreshToken,
} from './token.crypto.js';

// A random fingerprint that matches no real token. Ending a session scrambles its stored hash
// so the old token is later answered as "invalid", not mistaken for a stolen, already-used token.
function scrambledHash(): string {
  return hashRefreshToken(generateRefreshToken());
}

@Injectable()
export class LogoutService {
  constructor(private readonly prisma: PrismaService) {}

  // Ends the session that this refresh token belongs to.
  // Always resolves, whatever the token is, so the endpoint reveals nothing about which tokens exist.
  async logout(presentedToken: string): Promise<void> {
    if (!isWellFormedRefreshToken(presentedToken)) return;

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashRefreshToken(presentedToken) },
      select: { id: true, revokedAt: true },
    });
    if (!session || session.revokedAt !== null) return;

    await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), refreshTokenHash: scrambledHash() },
    });
  }

  // Ends every active session of the user (all devices, including the current one).
  async logoutAll(userId: string): Promise<{ revokedSessions: number }> {
    const now = new Date();

    const revokedSessions = await this.prisma.$transaction(async (tx) => {
      const active = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { id: true },
      });

      // One update per session: every scrambled fingerprint has to be different (the column is unique).
      let count = 0;
      for (const { id } of active) {
        const result = await tx.session.updateMany({
          where: { id, revokedAt: null },
          data: { revokedAt: now, refreshTokenHash: scrambledHash() },
        });
        count += result.count;
      }
      return count;
    });

    return { revokedSessions };
  }
}