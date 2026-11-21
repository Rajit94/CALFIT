import { Injectable } from '@nestjs/common';
import { isUuid } from '../common/uuid.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { gymForbidden, gymNotFound, gymReadOnly, gymSuspended } from './gym-errors.js';

export type GymRoleName = 'OWNER' | 'TRAINER' | 'MEMBER';

const RANK: Record<GymRoleName, number> = { OWNER: 3, TRAINER: 2, MEMBER: 1 };

export interface GymAccess {
  gymId: string;
  roles: GymRoleName[]; // every ACTIVE role this person has in the gym
  gymStatus: string;
  subscriptionStatus: string | null;
}

export function primaryRole(roles: readonly GymRoleName[]): GymRoleName {
  return [...roles].sort((a, b) => RANK[b] - RANK[a])[0] ?? 'MEMBER';
}

// The one place that answers "may this person act in this gym?". Later modules reuse it.
// Any ACTIVE role counts as member-level access, so owners need no separate MEMBER row to use
// member-facing features that only need a gym and a user (gym details, holidays, check-in, streaks).
@Injectable()
export class GymAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // 404 for everyone who is not an active person in the gym: no probing which gyms exist.
  async requireMember(userId: string, gymId: string): Promise<GymAccess> {
    if (!isUuid(gymId)) throw gymNotFound();
    const rows = await this.prisma.gymMember.findMany({
      where: { gymId, userId, status: 'ACTIVE' },
      select: {
        role: true,
        gym: { select: { status: true, subscription: { select: { status: true } } } },
      },
    });
    const first = rows[0];
    if (!first) throw gymNotFound();
    return {
      gymId,
      roles: rows.map((r) => r.role),
      gymStatus: first.gym.status,
      subscriptionStatus: first.gym.subscription?.status ?? null,
    };
  }

  async requireOwner(userId: string, gymId: string): Promise<GymAccess> {
    const access = await this.requireMember(userId, gymId);
    if (!access.roles.includes('OWNER')) throw gymForbidden();
    return access;
  }

  // Reading always works. Writes are refused when the gym is suspended or its subscription is READ_ONLY.
  assertWritable(access: GymAccess): void {
    if (access.gymStatus === 'SUSPENDED') throw gymSuspended();
    if (access.subscriptionStatus === 'READ_ONLY') throw gymReadOnly();
  }
}