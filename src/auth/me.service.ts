import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ParentalConsentPolicy } from '../common/profile/parental-consent.policy.js';
import { buildProfileStatus } from '../common/profile/profile-status.js';
import type { ProfileStatus } from '../common/profile/profile-status.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface MeResult extends ProfileStatus {
  id: string;
  phone: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  privacy: string;
  createdAt: string;
  gyms: Array<{ gymId: string; gymName: string; role: string; status: string }>;
}

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ParentalConsentPolicy,
  ) {}

  async getMe(userId: string): Promise<MeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        username: true,
        name: true,
        avatarUrl: true,
        bio: true,
        privacy: true,
        dateOfBirth: true,
        profileCompletedAt: true,
        createdAt: true,
        parentalConsent: { select: { guardianPhone: true, verifiedAt: true } },
        gymMemberships: {
          where: { status: { in: ['INVITED', 'PENDING', 'ACTIVE'] } },
          orderBy: { createdAt: 'asc' },
          select: { gymId: true, role: true, status: true, gym: { select: { name: true } } },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'This session is no longer valid.',
      });
    }

    const policy = await this.policy.get();
    const status = buildProfileStatus(
      {
        dateOfBirth: user.dateOfBirth,
        profileCompletedAt: user.profileCompletedAt,
        parentalConsent: user.parentalConsent,
      },
      policy,
      new Date(),
    );

    return {
      id: user.id,
      phone: user.phone,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      privacy: user.privacy,
      createdAt: user.createdAt.toISOString(),
      gyms: user.gymMemberships.map((m) => ({
        gymId: m.gymId,
        gymName: m.gym.name,
        role: m.role,
        status: m.status,
      })),
      ...status,
    };
  }
}