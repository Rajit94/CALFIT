import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TERMS_VERSION } from '../auth/auth.constants.js';
import { isUuid } from '../common/uuid.js';
import { gymReadOnly } from '../gyms/gym-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

const invitationNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'INVITATION_NOT_FOUND', message: 'No invitation found for you in this gym.' });

export interface AcceptResult {
  gymId: string;
  gymName: string;
  status: 'ACTIVE';
}

// A registered person whose membership is INVITED (for example an owner re-added them after removal)
// accepts it here, without needing the gym code. Newly added people who have no account yet are
// activated automatically when their phone number is linked.
@Injectable()
export class InvitationService {
  constructor(private readonly prisma: PrismaService) {}

  async accept(
    userId: string,
    gymId: string,
    whatsappConsent: boolean,
    ip: string | undefined,
  ): Promise<AcceptResult> {
    if (!isUuid(gymId)) throw invitationNotFound();

    const row = await this.prisma.gymMember.findFirst({
      where: { gymId, userId, role: 'MEMBER' },
      select: {
        id: true,
        status: true,
        joinedAt: true,
        gym: { select: { name: true, status: true, subscription: { select: { status: true } } } },
      },
    });
    if (!row || row.gym.status !== 'ACTIVE') throw invitationNotFound();
    if (row.status === 'ACTIVE') {
      throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'You are already a member of this gym.' });
    }
    if (row.status !== 'INVITED') throw invitationNotFound();
    if (row.gym.subscription?.status === 'READ_ONLY') throw gymReadOnly();

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Only succeeds while the row is still INVITED, so two taps cannot both win.
      const result = await tx.gymMember.updateMany({
        where: { id: row.id, status: 'INVITED' },
        data: {
          status: 'ACTIVE',
          joinedAt: row.joinedAt ?? now,
          approvedAt: now,
          removedAt: null,
          whatsappConsent,
          whatsappConsentAt: whatsappConsent ? now : null,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException({ code: 'ALREADY_MEMBER', message: 'You are already a member of this gym.' });
      }

      const active = await tx.consentRecord.findFirst({
        where: { userId, gymId, type: 'WHATSAPP', revokedAt: null },
        select: { id: true },
      });
      if (whatsappConsent && !active) {
        await tx.consentRecord.create({
          data: { userId, gymId, type: 'WHATSAPP', version: TERMS_VERSION, ip: ip ?? null },
        });
      } else if (!whatsappConsent && active) {
        await tx.consentRecord.updateMany({
          where: { userId, gymId, type: 'WHATSAPP', revokedAt: null },
          data: { revokedAt: now },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: userId,
          gymId,
          action: 'gym_member.invitation_accepted',
          entityType: 'gym_member',
          entityId: row.id,
          ip: ip ?? null,
        },
      });
    });

    return { gymId, gymName: row.gym.name, status: 'ACTIVE' };
  }
}