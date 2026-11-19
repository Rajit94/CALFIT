import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpService } from '../auth/otp.service.js';
import type { OtpRequestResult } from '../auth/otp.service.js';
import { maskPhone } from '../auth/validation.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import {
  ageInYears,
  checkDateOfBirth,
  fromDateOnly,
  istDateString,
  toDateOnly,
} from '../common/profile/age.js';
import type { DobCheck } from '../common/profile/age.js';
import { ParentalConsentPolicy } from '../common/profile/parental-consent.policy.js';
import type { ParentalConsentConfig } from '../common/profile/parental-consent.policy.js';
import { buildProfileStatus } from '../common/profile/profile-status.js';
import type { ProfileStatus } from '../common/profile/profile-status.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  GuardianDto,
  GuardianVerifyDto,
  SetupProfileDto,
  UpdateProfileDto,
} from './users.schemas.js';

const USERNAME_CHANGE_INTERVAL_DAYS = 30;

export interface ProfileResponse extends ProfileStatus {
  id: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  privacy: string;
}

export interface GuardianRequestResult extends OtpRequestResult {
  guardianPhoneMasked: string;
}

const conflict = (code: string, message: string): ConflictException =>
  new ConflictException({ code, message });

const usernameTaken = (): ConflictException =>
  conflict('USERNAME_TAKEN', 'This username is already taken.');

type DobFailure = Extract<DobCheck, { ok: false }>['reason'];

function dobError(reason: DobFailure, minAge: number): HttpException {
  if (reason === 'TOO_YOUNG') {
    return new ForbiddenException({
      code: 'AGE_TOO_YOUNG',
      message: `You must be at least ${minAge} years old to use CALFIT.`,
    });
  }
  return new BadRequestException({
    code: 'DATE_OF_BIRTH_INVALID',
    message: 'Please enter a valid date of birth.',
  });
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly policy: ParentalConsentPolicy,
  ) {}

  async isUsernameAvailable(username: string, userId: string): Promise<boolean> {
    const existing = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return existing === null || existing.id === userId;
  }

  async getProfile(userId: string): Promise<ProfileResponse> {
    const user = await this.loadUser(userId);
    return this.toResponse(user, await this.policy.get());
  }

  // First-time setup. Allowed until the profile is complete; the date of birth can never change once saved.
  async setupProfile(userId: string, dto: SetupProfileDto): Promise<ProfileResponse> {
    const now = new Date();
    const policy = await this.policy.get();

    const check = checkDateOfBirth(dto.dateOfBirth, istDateString(now), policy.minAge);
    if (!check.ok) throw dobError(check.reason, policy.minAge);

    const user = await this.loadUser(userId);
    if (user.profileCompletedAt) {
      throw conflict(
        'PROFILE_ALREADY_COMPLETED',
        'Your profile is already set up. Use PATCH /users/me/profile to edit it.',
      );
    }
    if (user.dateOfBirth && toDateOnly(user.dateOfBirth) !== dto.dateOfBirth) {
      throw conflict(
        'DATE_OF_BIRTH_LOCKED',
        'Your date of birth cannot be changed once saved. Contact support if it is wrong.',
      );
    }

    const isMinor = check.age < policy.adultAge;
    const guardianVerified = Boolean(user.parentalConsent?.verifiedAt);
    const complete = !policy.enabled || !isMinor || guardianVerified;

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          name: dto.name,
          username: dto.username,
          dateOfBirth: fromDateOnly(dto.dateOfBirth),
          ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
          ...(isMinor ? { privacy: 'PRIVATE' as const } : {}),
          ...(complete ? { profileCompletedAt: now } : {}),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw usernameTaken();
      throw error;
    }
    return this.getProfile(userId);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
    ip: string | undefined,
  ): Promise<ProfileResponse> {
    const now = new Date();
    const policy = await this.policy.get();
    const user = await this.loadUser(userId);

    if (!user.profileCompletedAt || !user.dateOfBirth) {
      throw conflict('PROFILE_NOT_COMPLETED', 'Finish setting up your profile first.');
    }

    const age = ageInYears(toDateOnly(user.dateOfBirth), istDateString(now));
    if (dto.privacy === 'PUBLIC' && age < policy.adultAge) {
      throw new ForbiddenException({
        code: 'MINOR_MUST_BE_PRIVATE',
        message: `Accounts of people under ${policy.adultAge} stay private.`,
      });
    }

    const newUsername =
      dto.username !== undefined && dto.username !== user.username ? dto.username : undefined;
    if (newUsername !== undefined) {
      const last = await this.prisma.auditLog.findFirst({
        where: { actorId: userId, action: 'user.username_changed' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last) {
        const allowedAt = new Date(
          last.createdAt.getTime() + USERNAME_CHANGE_INTERVAL_DAYS * 86_400_000,
        );
        if (allowedAt.getTime() > now.getTime()) {
          throw new HttpException(
            {
              code: 'USERNAME_CHANGE_TOO_SOON',
              message: `You can change your username again on ${allowedAt.toISOString().slice(0, 10)}.`,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    }

    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      ...(dto.privacy !== undefined ? { privacy: dto.privacy } : {}),
      ...(newUsername !== undefined ? { username: newUsername } : {}),
    };

    if (Object.keys(data).length > 0) {
      try {
        // The audit row is what starts the 30-day clock, so it is written in the same transaction.
        await this.prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: userId }, data });
          if (newUsername !== undefined) {
            await tx.auditLog.create({
              data: {
                actorId: userId,
                action: 'user.username_changed',
                entityType: 'user',
                entityId: userId,
                metadata: { from: user.username, to: newUsername },
                ip: ip ?? null,
              },
            });
          }
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw usernameTaken();
        throw error;
      }
    }
    return this.getProfile(userId);
  }

  // Under-18 only. Sends a code to the guardian's phone. This proves control of that phone number,
  // NOT legal guardianship.
  async requestGuardianConsent(
    userId: string,
    dto: GuardianDto,
    ip: string | undefined,
  ): Promise<GuardianRequestResult> {
    const policy = await this.policy.get();
    const user = await this.loadUser(userId);

    const age = user.dateOfBirth ? ageInYears(toDateOnly(user.dateOfBirth), istDateString()) : null;
    if (age === null) {
      throw conflict('PROFILE_DETAILS_REQUIRED', 'Save your profile details, including your date of birth, first.');
    }
    if (!policy.enabled || age >= policy.adultAge) {
      throw conflict('GUARDIAN_NOT_REQUIRED', 'Guardian consent is not required for this account.');
    }
    if (user.profileCompletedAt || user.parentalConsent?.verifiedAt) {
      throw conflict('GUARDIAN_ALREADY_VERIFIED', 'Guardian consent is already recorded.');
    }
    if (dto.guardianPhone === user.phone) {
      throw new BadRequestException({
        code: 'GUARDIAN_PHONE_INVALID',
        message: "The guardian's phone number must be different from your own.",
      });
    }

    await this.prisma.parentalConsent.upsert({
      where: { userId },
      create: { userId, guardianName: dto.guardianName, guardianPhone: dto.guardianPhone },
      update: { guardianName: dto.guardianName, guardianPhone: dto.guardianPhone, verifiedAt: null },
    });

    const sent = await this.otp.requestOtp(dto.guardianPhone, ip);
    return { guardianPhoneMasked: maskPhone(dto.guardianPhone), ...sent };
  }

  async verifyGuardianConsent(
    userId: string,
    dto: GuardianVerifyDto,
    ip: string | undefined,
  ): Promise<ProfileResponse> {
    const policy = await this.policy.get();
    const user = await this.loadUser(userId);

    const consent = user.parentalConsent;
    if (!consent) {
      throw conflict('GUARDIAN_NOT_REQUESTED', 'Ask for a guardian code first.');
    }
    if (consent.verifiedAt) {
      throw conflict('GUARDIAN_ALREADY_VERIFIED', 'Guardian consent is already recorded.');
    }

    await this.otp.verifyOtp(consent.guardianPhone, dto.code); // throws the OTP_* errors

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.parentalConsent.update({ where: { userId }, data: { verifiedAt: now } });
      await tx.consentRecord.create({
        data: { userId, type: 'PARENTAL', version: policy.version, ip: ip ?? null },
      });
      if (!user.profileCompletedAt && user.name && user.username && user.dateOfBirth) {
        await tx.user.update({ where: { id: userId }, data: { profileCompletedAt: now } });
      }
    });
    return this.getProfile(userId);
  }

  private async loadUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        username: true,
        name: true,
        bio: true,
        privacy: true,
        dateOfBirth: true,
        profileCompletedAt: true,
        parentalConsent: { select: { guardianPhone: true, verifiedAt: true } },
      },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: 'SESSION_INVALID',
        message: 'This session is no longer valid.',
      });
    }
    return user;
  }

  private toResponse(
    user: Awaited<ReturnType<UsersService['loadUser']>>,
    policy: ParentalConsentConfig,
  ): ProfileResponse {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      bio: user.bio,
      privacy: user.privacy,
      ...buildProfileStatus(
        {
          dateOfBirth: user.dateOfBirth,
          profileCompletedAt: user.profileCompletedAt,
          parentalConsent: user.parentalConsent,
        },
        policy,
        new Date(),
      ),
    };
  }
}