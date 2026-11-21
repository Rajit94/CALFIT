import { ForbiddenException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { ageInYears, istDateString, toDateOnly } from '../common/profile/age.js';
import { ParentalConsentPolicy } from '../common/profile/parental-consent.policy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GymAccessService, primaryRole } from './gym-access.service.js';
import type { GymAccess, GymRoleName } from './gym-access.service.js';
import { generateGymCode, generateQrSecret } from './gym-code.js';
import { gymNotFound, profileNotCompleted, sessionInvalid } from './gym-errors.js';
import {
  DEFAULT_CHECK_IN_RADIUS_M,
  GYM_CODE_ATTEMPTS,
  MAX_GYMS_PER_OWNER,
  MONTHLY_MESSAGE_ALLOWANCE,
  TRIAL_MONTHS,
  TRIAL_PRICE_PER_MONTH,
} from './gym.constants.js';
import type { CreateGymDto, UpdateGymDto } from './gyms.schemas.js';
import { addCalendarMonths, trialDaysLeft } from './trial.js';

export interface GymDetail {
  id: string;
  name: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
  checkInRadiusM: number;
  timezone: string;
  timings: unknown;
  logoUrl: string | null;
  coverUrl: string | null;
  isVerified: boolean;
  status: string;
  createdAt: string;
  myRole: GymRoleName;
  myRoles: GymRoleName[];
  // Owner only:
  code?: string;
  pendingJoinRequests?: number;
  subscription?: {
    status: string;
    trialEndsAt: string;
    trialDaysLeft: number | null;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
    pricePerMonth: number;
    monthlyMessageLimit: number;
  } | null;
}

export interface GymPreview {
  name: string;
  description: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  isVerified: boolean;
  memberCount: number;
  myRoles: string[]; // ACTIVE roles you already have here (for example OWNER)
  myRequest: { status: string } | null; // your MEMBER request, if any
}

@Injectable()
export class GymsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
    private readonly policy: ParentalConsentPolicy,
  ) {}

  async create(userId: string, dto: CreateGymDto, ip: string | undefined): Promise<GymDetail> {
    const policy = await this.policy.get();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { profileCompletedAt: true, dateOfBirth: true },
    });
    if (!user) throw sessionInvalid();
    if (!user.profileCompletedAt || !user.dateOfBirth) throw profileNotCompleted();

    if (ageInYears(toDateOnly(user.dateOfBirth), istDateString()) < policy.adultAge) {
      throw new ForbiddenException({
        code: 'GYM_OWNER_MUST_BE_ADULT',
        message: `You must be at least ${policy.adultAge} years old to create a gym.`,
      });
    }

    const owned = await this.prisma.gymMember.count({
      where: { userId, role: 'OWNER', status: 'ACTIVE' },
    });
    if (owned >= MAX_GYMS_PER_OWNER) {
      throw new ForbiddenException({
        code: 'GYM_LIMIT_REACHED',
        message: `You can own up to ${MAX_GYMS_PER_OWNER} gyms.`,
      });
    }

    // Everything is created together or not at all. A (very unlikely) code collision is retried.
    for (let attempt = 0; attempt < GYM_CODE_ATTEMPTS; attempt++) {
      try {
        const gymId = await this.prisma.$transaction(async (tx) => {
          const now = new Date();
          const gym = await tx.gym.create({
            data: {
              name: dto.name,
              code: generateGymCode(),
              description: dto.description ?? null,
              address: dto.address ?? null,
              city: dto.city,
              state: dto.state ?? null,
              pincode: dto.pincode ?? null,
              latitude: dto.latitude,
              longitude: dto.longitude,
              checkInRadiusM: dto.checkInRadiusM ?? DEFAULT_CHECK_IN_RADIUS_M,
              qrSecret: generateQrSecret(),
              createdById: userId,
              ...(dto.timings !== undefined ? { timings: dto.timings as never } : {}),
            },
            select: { id: true },
          });
          await tx.gymMember.create({
            data: {
              gymId: gym.id,
              userId,
              role: 'OWNER',
              status: 'ACTIVE',
              joinedAt: now,
              approvedAt: now,
              approvedById: userId,
            },
          });
          await tx.gymSubscription.create({
            data: {
              gymId: gym.id,
              status: 'TRIAL',
              trialStartsAt: now,
              trialEndsAt: addCalendarMonths(now, TRIAL_MONTHS),
              pricePerMonth: TRIAL_PRICE_PER_MONTH,
              monthlyMessageLimit: MONTHLY_MESSAGE_ALLOWANCE,
            },
          });
          await tx.gymReminderSettings.create({ data: { gymId: gym.id } });
          await tx.auditLog.create({
            data: {
              actorId: userId,
              gymId: gym.id,
              action: 'gym.created',
              entityType: 'gym',
              entityId: gym.id,
              ip: ip ?? null,
            },
          });
          return gym.id;
        });
        return await this.getForUser(userId, gymId);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new InternalServerErrorException('Could not generate a unique gym code');
  }

  async getForUser(userId: string, gymId: string): Promise<GymDetail> {
    const access = await this.access.requireMember(userId, gymId);
    return this.buildDetail(access);
  }

  async update(
    userId: string,
    gymId: string,
    dto: UpdateGymDto,
    ip: string | undefined,
  ): Promise<GymDetail> {
    const access = await this.access.requireOwner(userId, gymId);
    this.access.assertWritable(access);

    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
      ...(dto.city !== undefined ? { city: dto.city } : {}),
      ...(dto.state !== undefined ? { state: dto.state } : {}),
      ...(dto.pincode !== undefined ? { pincode: dto.pincode } : {}),
      ...(dto.latitude !== undefined ? { latitude: dto.latitude } : {}),
      ...(dto.longitude !== undefined ? { longitude: dto.longitude } : {}),
      ...(dto.checkInRadiusM !== undefined ? { checkInRadiusM: dto.checkInRadiusM } : {}),
      ...(dto.timings !== undefined ? { timings: dto.timings as never } : {}),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.gym.update({ where: { id: gymId }, data });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          gymId,
          action: 'gym.updated',
          entityType: 'gym',
          entityId: gymId,
          metadata: { fields: Object.keys(data) }, // field names only
          ip: ip ?? null,
        },
      });
    });
    return this.buildDetail(access);
  }

  // What a person sees before asking to join. Deliberately minimal: no id, location or code.
  async preview(userId: string, code: string): Promise<GymPreview> {
    const gym = await this.prisma.gym.findUnique({
      where: { code },
      select: {
        id: true,
        name: true,
        description: true,
        address: true,
        city: true,
        state: true,
        logoUrl: true,
        coverUrl: true,
        isVerified: true,
        status: true,
      },
    });
    if (!gym || gym.status !== 'ACTIVE') throw gymNotFound();

    const [memberCount, mine] = await Promise.all([
      this.prisma.gymMember.count({ where: { gymId: gym.id, role: 'MEMBER', status: 'ACTIVE' } }),
      this.prisma.gymMember.findMany({
        where: { gymId: gym.id, userId },
        select: { role: true, status: true },
      }),
    ]);

    const memberRow = mine.find((m) => m.role === 'MEMBER');
    return {
      name: gym.name,
      description: gym.description,
      address: gym.address,
      city: gym.city,
      state: gym.state,
      logoUrl: gym.logoUrl,
      coverUrl: gym.coverUrl,
      isVerified: gym.isVerified,
      memberCount,
      myRoles: mine.filter((m) => m.status === 'ACTIVE').map((m) => m.role),
      myRequest: memberRow ? { status: memberRow.status } : null,
    };
  }

  private async buildDetail(access: GymAccess): Promise<GymDetail> {
    const gym = await this.prisma.gym.findUnique({
      where: { id: access.gymId },
      select: {
        id: true,
        name: true,
        description: true,
        address: true,
        city: true,
        state: true,
        pincode: true,
        latitude: true,
        longitude: true,
        checkInRadiusM: true,
        timezone: true,
        timings: true,
        logoUrl: true,
        coverUrl: true,
        isVerified: true,
        status: true,
        createdAt: true,
        code: true,
        subscription: {
          select: {
            status: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            graceEndsAt: true,
            pricePerMonth: true,
            monthlyMessageLimit: true,
          },
        },
      },
    });
    if (!gym) throw gymNotFound();

    const base: GymDetail = {
      id: gym.id,
      name: gym.name,
      description: gym.description,
      address: gym.address,
      city: gym.city,
      state: gym.state,
      pincode: gym.pincode,
      latitude: gym.latitude,
      longitude: gym.longitude,
      checkInRadiusM: gym.checkInRadiusM,
      timezone: gym.timezone,
      timings: gym.timings,
      logoUrl: gym.logoUrl,
      coverUrl: gym.coverUrl,
      isVerified: gym.isVerified,
      status: gym.status,
      createdAt: gym.createdAt.toISOString(),
      myRole: primaryRole(access.roles),
      myRoles: access.roles,
    };
    if (!access.roles.includes('OWNER')) return base;

    const pending = await this.prisma.gymMember.count({
      where: { gymId: gym.id, role: 'MEMBER', status: 'PENDING' },
    });
    const sub = gym.subscription;
    return {
      ...base,
      code: gym.code,
      pendingJoinRequests: pending,
      subscription: sub
        ? {
            status: sub.status,
            trialEndsAt: sub.trialEndsAt.toISOString(),
            trialDaysLeft: sub.status === 'TRIAL' ? trialDaysLeft(sub.trialEndsAt, new Date()) : null,
            currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
            graceEndsAt: sub.graceEndsAt ? sub.graceEndsAt.toISOString() : null,
            pricePerMonth: Number(sub.pricePerMonth),
            monthlyMessageLimit: sub.monthlyMessageLimit,
          }
        : null,
    };
  }
}