import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface MeResult {
  id: string;
  phone: string; // the user's OWN number; never exposed on public profiles
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  privacy: string;
  profileCompleted: boolean;
  createdAt: string;
  gyms: Array<{ gymId: string; gymName: string; role: string; status: string }>;
}

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

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
        profileCompletedAt: true,
        createdAt: true,
        gymMemberships: {
          // REJECTED and REMOVED memberships are hidden from the app.
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

    return {
      id: user.id,
      phone: user.phone,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      privacy: user.privacy,
      profileCompleted: user.profileCompletedAt !== null,
      createdAt: user.createdAt.toISOString(),
      gyms: user.gymMemberships.map((m) => ({
        gymId: m.gymId,
        gymName: m.gym.name,
        role: m.role,
        status: m.status,
      })),
    };
  }
}