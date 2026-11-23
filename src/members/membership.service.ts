import { Injectable, NotFoundException } from '@nestjs/common';
import { TERMS_VERSION } from '../auth/auth.constants.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const membershipNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND', message: 'You are not a member of this gym.' });

// Things a member does about their OWN membership.
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  // Deliberately allowed in read-only and suspended gyms: withdrawing consent is a right, and
  // opting in sends nothing while the gym cannot send.
  async setWhatsappConsent(
    userId: string,
    gymId: string,
    consent: boolean,
    ip: string | undefined,
  ): Promise<{ whatsappConsent: boolean }> {
    const access = await this.access.requireMember(userId, gymId);
    if (!access.roles.includes('MEMBER')) throw membershipNotFound();

    const row = await this.prisma.gymMember.findFirst({
      where: { gymId, userId, role: 'MEMBER', status: 'ACTIVE' },
      select: { id: true, whatsappConsent: true },
    });
    if (!row) throw membershipNotFound();
    if (row.whatsappConsent === consent) return { whatsappConsent: consent };

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.gymMember.update({
        where: { id: row.id },
        data: { whatsappConsent: consent, whatsappConsentAt: consent ? now : null },
      });

      const active = await tx.consentRecord.findFirst({
        where: { userId, gymId, type: 'WHATSAPP', revokedAt: null },
        select: { id: true },
      });
      if (consent && !active) {
        await tx.consentRecord.create({
          data: { userId, gymId, type: 'WHATSAPP', version: TERMS_VERSION, ip: ip ?? null },
        });
      } else if (!consent && active) {
        await tx.consentRecord.updateMany({
          where: { userId, gymId, type: 'WHATSAPP', revokedAt: null },
          data: { revokedAt: now },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: userId,
          gymId,
          action: 'gym_member.whatsapp_consent_changed',
          entityType: 'gym_member',
          entityId: row.id,
          metadata: { whatsappConsent: consent },
          ip: ip ?? null,
        },
      });
    });
    return { whatsappConsent: consent };
  }
}