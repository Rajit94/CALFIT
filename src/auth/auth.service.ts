import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readNumber } from './auth-config.js';
import { TERMS_VERSION } from './auth.constants.js';
import type { ClientDetails } from './client-info.decorator.js';
import { OtpService } from './otp.service.js';
import { generateRefreshToken, hashRefreshToken } from './token.crypto.js';

export interface VerifyOtpInput {
  phone: string;
  code: string;
  device?: { name?: string | undefined; platform?: string | undefined } | undefined;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresAt: string;
  isNewUser: boolean;
  user: {
    id: string;
    username: string | null;
    name: string | null;
    avatarUrl: string | null;
    profileCompleted: boolean;
  };
}

function assertCanSignIn(status: string): void {
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
export class AuthService {
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly otp: OtpService,
    private readonly jwt: JwtService,
  ) {
    this.accessTtlSeconds = readNumber(config, 'JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlDays = readNumber(config, 'REFRESH_TTL_DAYS');
  }

  // Registration and login are the same flow: a valid OTP signs you in,
  // and creates the account first if the phone number is new.
  async verifyOtpAndSignIn(input: VerifyOtpInput, client: ClientDetails): Promise<LoginResult> {
    const { phone } = input;
    await this.otp.verifyOtp(phone, input.code);

    const now = new Date();
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTtlDays * 86_400_000);

    const { user, session, isNewUser } = await this.prisma.$transaction(async (tx) => {
      let isNewUser = false;
      let user = await tx.user.findUnique({ where: { phone } });

      if (!user) {
        isNewUser = true;
        user = await tx.user.create({ data: { phone, phoneVerifiedAt: now } });
        await tx.consentRecord.createMany({
          data: [
            { userId: user.id, type: 'TERMS', version: TERMS_VERSION, ip: client.ip ?? null },
            { userId: user.id, type: 'PRIVACY', version: TERMS_VERSION, ip: client.ip ?? null },
          ],
        });
      } else {
        assertCanSignIn(user.status);
        if (!user.phoneVerifiedAt) {
          user = await tx.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: now } });
        }
      }

      const session = await tx.session.create({
        data: {
          userId: user.id,
          refreshTokenHash: hashRefreshToken(refreshToken),
          deviceName: input.device?.name ?? client.userAgent?.slice(0, 200) ?? null,
          platform: input.device?.platform ?? null,
          ip: client.ip ?? null,
          expiresAt: refreshExpiresAt,
        },
      });

      return { user, session, isNewUser };
    });

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: session.id },
      { expiresIn: this.accessTtlSeconds },
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
      isNewUser,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        profileCompleted: user.profileCompletedAt !== null,
      },
    };
  }
}