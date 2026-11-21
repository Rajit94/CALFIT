import { Injectable } from '@nestjs/common';
import { maskPhone } from '../auth/validation.js';
import { TERMS_VERSION } from '../auth/auth.constants.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { isUuid } from '../common/uuid.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GymAccessService } from './gym-access.service.js';
import {
  conflict,
  gymNotFound,
  gymReadOnly,
  profileNotCompleted,
  sessionInvalid,
  tooMany,
} from './gym-errors.js';
import { JOIN_RETRY_AFTER_DAYS } from './gym.constants.js';
import type { JoinGymDto } from './gyms.schemas.js';
import { NotFoundException } from '@nestjs/common';

export interface JoinResult {
  gymId: string;
  gymName: string;
  status: 'PENDING' | 'ACTIVE';
  autoApproved: boolean;
}

export interface JoinRequestItem {
  memberId: string;
  requestedAt: string;
  whatsappConsent: boolean;
  user: {
    id: string;
    name: string | null;
    username: string | null;
    avatarUrl: string | null;
    phoneMasked: string; // the owner sees the full number only after approval (members module)
  };
}

const requestNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'JOIN_REQUEST_NOT_FOUND', message: 'Join request not found.' });

@Injectable()
export class JoinRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  async join(userId: string, dto: JoinGymDto, ip: string | undefined): Promise<JoinResult> {
    const now = new Date();

    const gym = await this.prisma.gym.findUnique({
      where: { code: dto.code },
      select: { id: true, name: true, status: true, subscription: { select: { status: true } } },
    });
    if (!gym || gym.status !== 'ACTIVE') throw gymNotFound();
    if (gym.subscription?.status === 'READ_ONLY') throw gymReadOnly();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, profileCompletedAt: true },
    });
    if (!user) throw sessionInvalid();
    if (!user.profileCompletedAt) throw profileNotCompleted();

    const ownerRow = await this.prisma.gymMember.findFirst({
      where: { gymId: gym.id, userId, role: 'OWNER', status: 'ACTIVE' },
      select: { id: true },
    });
    const isOwner = ownerRow !== null;

    const existing = await this.prisma.gymMember.findFirst({
      where: { gymId: gym.id, userId, role: 'MEMBER' },
      select: { id: true, status: true, joinedAt: true, removedAt: true, updatedAt: true },
    });

    let target: { id: string; joinedAt: Date | null } | null = null;
    let viaInvitation = false;

    if (existing) {
      if (existing.status === 'ACTIVE') {
        throw conflict('ALREADY_MEMBER', 'You are already a member of this gym.');
      }
      if (existing.status === 'PENDING') {
        throw conflict('JOIN_REQUEST_PENDING', 'Your request is waiting for the owner to respond.');
      }
      if (existing.status === 'REJECTED' || existing.status === 'REMOVED') {
        const since = existing.removedAt ?? existing.updatedAt;
        const retryAt = new Date(since.getTime() + JOIN_RETRY_AFTER_DAYS * 86_400_000);
        if (retryAt.getTime() > now.getTime()) {
          throw tooMany(
            'JOIN_REQUEST_TOO_SOON',
            `You can ask to join again on ${retryAt.toISOString().slice(0, 10)}.`,
          );
        }
      }
      viaInvitation = existing.status === 'INVITED';
      target = existing;
    } else {
      // A row the owner created in advance (member import) for this phone number: use it, so fee history stays attached.
      const imported = await this.prisma.gymMember.findFirst({
        where: {
          gymId: gym.id,
          role: 'MEMBER',
          status: 'INVITED',
          userId: null,
          invitedPhone: user.phone,
        },
        select: { id: true, joinedAt: true },
      });
      if (imported) {
        target = imported;
        viaInvitation = true;
      }
    }

    const autoApprove = isOwner || viaInvitation;
    const status = autoApprove ? ('ACTIVE' as const) : ('PENDING' as const);
    const consent = {
      whatsappConsent: dto.whatsappConsent,
      whatsappConsentAt: dto.whatsappConsent ? now : null,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        let memberId: string;
        if (target) {
          await tx.gymMember.update({
            where: { id: target.id },
            data: {
              userId,
              status,
              removedAt: null,
              ...consent,
              ...(autoApprove
                ? {
                    joinedAt: target.joinedAt ?? now,
                    approvedAt: now,
                    approvedById: isOwner ? userId : null,
                  }
                : { approvedAt: null, approvedById: null }),
            },
          });
          memberId = target.id;
        } else {
          const created = await tx.gymMember.create({
            data: {
              gymId: gym.id,
              userId,
              role: 'MEMBER',
              status,
              ...consent,
              ...(autoApprove ? { joinedAt: now, approvedAt: now, approvedById: userId } : {}),
            },
            select: { id: true },
          });
          memberId = created.id;
        }

        // Keep the consent record in step with the answer given now.
        const active = await tx.consentRecord.findFirst({
          where: { userId, gymId: gym.id, type: 'WHATSAPP', revokedAt: null },
          select: { id: true },
        });
        if (dto.whatsappConsent && !active) {
          await tx.consentRecord.create({
            data: { userId, gymId: gym.id, type: 'WHATSAPP', version: TERMS_VERSION, ip: ip ?? null },
          });
        } else if (!dto.whatsappConsent && active) {
          await tx.consentRecord.updateMany({
            where: { userId, gymId: gym.id, type: 'WHATSAPP', revokedAt: null },
            data: { revokedAt: now },
          });
        }

        await tx.auditLog.create({
          data: {
            actorId: userId,
            gymId: gym.id,
            action: autoApprove ? 'gym_member.joined' : 'gym_member.join_requested',
            entityType: 'gym_member',
            entityId: memberId,
            ip: ip ?? null,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('JOIN_REQUEST_PENDING', 'Your request is already being processed.');
      }
      throw error;
    }

    return { gymId: gym.id, gymName: gym.name, status, autoApproved: autoApprove };
  }

  async list(
    ownerId: string,
    gymId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: JoinRequestItem[]; nextCursor: string | null }> {
    await this.access.requireOwner(ownerId, gymId);

    const rows = await this.prisma.gymMember.findMany({
      where: { gymId, role: 'MEMBER', status: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        createdAt: true,
        whatsappConsent: true,
        user: { select: { id: true, name: true, username: true, avatarUrl: true, phone: true } },
      },
    });

    const page = rows.slice(0, query.limit);
    const items: JoinRequestItem[] = [];
    for (const row of page) {
      if (!row.user) continue;
      items.push({
        memberId: row.id,
        requestedAt: row.createdAt.toISOString(),
        whatsappConsent: row.whatsappConsent,
        user: {
          id: row.user.id,
          name: row.user.name,
          username: row.user.username,
          avatarUrl: row.user.avatarUrl,
          phoneMasked: maskPhone(row.user.phone),
        },
      });
    }
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > query.limit && last ? last.id : null };
  }

  async decide(
    ownerId: string,
    gymId: string,
    memberId: string,
    decision: 'approve' | 'reject',
    ip: string | undefined,
  ): Promise<{ memberId: string; status: 'ACTIVE' | 'REJECTED' }> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);
    if (!isUuid(memberId)) throw requestNotFound();

    const row = await this.prisma.gymMember.findFirst({
      where: { id: memberId, gymId, role: 'MEMBER', status: 'PENDING' },
      select: { id: true, joinedAt: true },
    });
    if (!row) throw requestNotFound();

    const now = new Date();
    const approve = decision === 'approve';

    await this.prisma.$transaction(async (tx) => {
      // Only succeeds while the request is still pending, so two decisions cannot both win.
      const result = await tx.gymMember.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: approve
          ? { status: 'ACTIVE', joinedAt: row.joinedAt ?? now, approvedAt: now, approvedById: ownerId }
          : { status: 'REJECTED', removedAt: now },
      });
      if (result.count !== 1) throw requestNotFound();
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: approve ? 'gym_member.approved' : 'gym_member.rejected',
          entityType: 'gym_member',
          entityId: row.id,
          ip: ip ?? null,
        },
      });
    });

    return { memberId: row.id, status: approve ? 'ACTIVE' : 'REJECTED' };
  }
}