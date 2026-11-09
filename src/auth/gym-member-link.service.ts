import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { maskPhone } from './validation.js';

// A "type" (not an "interface") so it can be stored inside the audit_logs JSON column.
export type LinkedMembership = { gymId: string; role: string };

export interface LinkSummary {
  linked: LinkedMembership[];
  conflicts: LinkedMembership[];
}

// Prisma errors are recognised by name and code, so this file does not import the generated client.
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'PrismaClientKnownRequestError' &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class GymMemberLinkService {
  private readonly logger = new Logger(GymMemberLinkService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Connects gym memberships that were created for this phone number in advance (member import,
  // trainer invite) to the user who has just proven they own the number. Safe to run on every
  // sign-in and safe to run twice. OWNER rows and rows in any status other than INVITED are never touched.
  async linkByPhone(
    userId: string,
    phone: string,
    ip?: string | undefined,
  ): Promise<LinkSummary> {
    const candidates = await this.prisma.gymMember.findMany({
      where: {
        invitedPhone: phone,
        userId: null,
        status: 'INVITED',
        role: { in: ['MEMBER', 'TRAINER'] },
      },
      select: { id: true, gymId: true, role: true, joinedAt: true },
    });

    const now = new Date();
    const linked: LinkedMembership[] = [];
    const conflicts: LinkedMembership[] = [];

    for (const row of candidates) {
      // An imported MEMBER is approved by the owner's import. A TRAINER must still accept the invitation.
      const data =
        row.role === 'MEMBER'
          ? { userId, status: 'ACTIVE' as const, joinedAt: row.joinedAt ?? now }
          : { userId };

      try {
        // Conditional update: only succeeds while the row is still unlinked and still INVITED,
        // so two sign-ins at the same moment cannot both claim it.
        const result = await this.prisma.gymMember.updateMany({
          where: { id: row.id, userId: null, status: 'INVITED' },
          data,
        });
        if (result.count === 1) linked.push({ gymId: row.gymId, role: row.role });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;

        // The person already has this role in this gym. Never merge or delete: the invited
        // row may carry fee history. Leave it for the owner or support to reconcile.
        conflicts.push({ gymId: row.gymId, role: row.role });
        if (await this.conflictAlreadyReported(row.id)) continue;
        this.logger.warn(
          `Could not link ${maskPhone(phone)} to gym ${row.gymId}: a ${row.role} membership already exists`,
        );
        await this.audit({
          actorId: userId,
          gymId: row.gymId,
          entityId: row.id,
          action: 'gym_member.link_conflict',
          metadata: { role: row.role, reason: 'membership already exists' },
          ip,
        });
      }
    }

    if (linked.length > 0) {
      await this.audit({
        actorId: userId,
        action: 'gym_member.linked_by_phone',
        metadata: { count: linked.length, memberships: linked },
        ip,
      });
    }

    return { linked, conflicts };
  }

  // An unresolved conflict stays a candidate at every sign-in. Report it once, not on every login.
  private async conflictAlreadyReported(rowId: string): Promise<boolean> {
    try {
      const existing = await this.prisma.auditLog.findFirst({
        where: { action: 'gym_member.link_conflict', entityType: 'gym_member', entityId: rowId },
        select: { id: true },
      });
      return existing !== null;
    } catch {
      return false;
    }
  }

  // A failed audit write is logged but never changes the outcome of the linking.
  private async audit(entry: {
    actorId: string;
    gymId?: string;
    entityId?: string;
    action: string;
    metadata: Record<string, string | number | LinkedMembership[]>;
    ip: string | undefined;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId,
          gymId: entry.gymId ?? null,
          action: entry.action,
          entityType: 'gym_member',
          entityId: entry.entityId ?? null,
          metadata: entry.metadata,
          ip: entry.ip ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not write audit entry ${entry.action}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}