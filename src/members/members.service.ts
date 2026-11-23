import { Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { isUuid } from '../common/uuid.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { conflict } from '../gyms/gym-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchesSearch, paginateMembers, toMemberDetail, toMemberItem } from './member-list.js';
import type { MemberDetail, MemberItem } from './member-list.js';
import type { AddMemberDto, ListableStatus, ListMembersQuery } from './members.schemas.js';

// Gyms are far below this in Phase 1. The list is filtered, sorted and paged in memory.
const MAX_LIST_ROWS = 5000;

const MEMBER_SELECT = {
  id: true,
  status: true,
  userId: true,
  invitedName: true,
  invitedPhone: true,
  joinedAt: true,
  approvedAt: true,
  removedAt: true,
  createdAt: true,
  whatsappConsent: true,
  whatsappConsentAt: true,
  user: { select: { name: true, username: true, avatarUrl: true, phone: true } },
} as const;

const memberNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found.' });

export interface MemberSummary {
  active: number;
  invited: number;
  pending: number;
  removed: number;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  async list(
    ownerId: string,
    gymId: string,
    query: ListMembersQuery,
  ): Promise<{ items: MemberItem[]; nextCursor: string | null }> {
    await this.access.requireOwner(ownerId, gymId);

    const statuses: ListableStatus[] = query.status ? [query.status] : ['ACTIVE', 'INVITED'];
    const rows = await this.prisma.gymMember.findMany({
      where: { gymId, role: 'MEMBER', status: { in: statuses } },
      select: MEMBER_SELECT,
      take: MAX_LIST_ROWS,
    });

    const search = query.q ?? '';
    const items = rows.map(toMemberItem).filter((item) => matchesSearch(item, search));
    return paginateMembers(items, {
      sort: query.sort,
      order: query.order ?? (query.sort === 'name' ? 'asc' : 'desc'),
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  async summary(ownerId: string, gymId: string): Promise<MemberSummary> {
    await this.access.requireOwner(ownerId, gymId);
    const count = (status: ListableStatus) =>
      this.prisma.gymMember.count({ where: { gymId, role: 'MEMBER', status } });
    const [active, invited, pending, removed] = await Promise.all([
      count('ACTIVE'),
      count('INVITED'),
      count('PENDING'),
      count('REMOVED'),
    ]);
    return { active, invited, pending, removed };
  }

  async getMember(ownerId: string, gymId: string, memberId: string): Promise<MemberDetail> {
    await this.access.requireOwner(ownerId, gymId);
    return this.loadDetail(gymId, memberId);
  }

  // Always creates an INVITED row and never links it here, so the answer cannot reveal whether the
  // number belongs to a registered user. The person becomes ACTIVE when the phone is linked at their
  // next sign-in or token refresh, or when they join with the gym code.
  async add(
    ownerId: string,
    gymId: string,
    dto: AddMemberDto,
    ip: string | undefined,
  ): Promise<MemberDetail> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);

    // A row may already exist: first by the number the owner invited, then by a registered user with this number.
    let existing = await this.prisma.gymMember.findFirst({
      where: { gymId, role: 'MEMBER', invitedPhone: dto.phone },
      select: { id: true, status: true, userId: true },
    });
    if (!existing) {
      const person = await this.prisma.user.findUnique({
        where: { phone: dto.phone },
        select: { id: true },
      });
      if (person) {
        existing = await this.prisma.gymMember.findFirst({
          where: { gymId, role: 'MEMBER', userId: person.id },
          select: { id: true, status: true, userId: true },
        });
      }
    }
    if (existing && existing.status !== 'REMOVED' && existing.status !== 'REJECTED') {
      throw conflict(
        'MEMBER_EXISTS',
        'This phone number is already in your member list or has a pending request.',
      );
    }

    const target = existing;
    const now = new Date();
    let memberId: string;
    try {
      memberId = await this.prisma.$transaction(async (tx) => {
        let id: string;
        if (target) {
          // A removed or rejected person: reuse the row (it may hold fee history). They must accept again,
          // so WhatsApp consent given for the earlier membership is cleared.
          await tx.gymMember.update({
            where: { id: target.id },
            data: {
              status: 'INVITED',
              invitedName: dto.name,
              invitedPhone: dto.phone,
              removedAt: null,
              approvedAt: null,
              approvedById: null,
              whatsappConsent: false,
              whatsappConsentAt: null,
            },
          });
          if (target.userId) {
            await tx.consentRecord.updateMany({
              where: { userId: target.userId, gymId, type: 'WHATSAPP', revokedAt: null },
              data: { revokedAt: now },
            });
          }
          id = target.id;
        } else {
          const created = await tx.gymMember.create({
            data: {
              gymId,
              role: 'MEMBER',
              status: 'INVITED',
              invitedName: dto.name,
              invitedPhone: dto.phone,
            },
            select: { id: true },
          });
          id = created.id;
        }
        await tx.auditLog.create({
          data: {
            actorId: ownerId,
            gymId,
            action: 'gym_member.added',
            entityType: 'gym_member',
            entityId: id,
            metadata: { reAdded: target !== null }, // no phone number in the audit trail
            ip: ip ?? null,
          },
        });
        return id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('MEMBER_EXISTS', 'This phone number is already in your member list.');
      }
      throw error;
    }
    return this.loadDetail(gymId, memberId);
  }

  // Ends access at once (every request checks for an ACTIVE membership). Fee history, check-ins
  // and the streak are untouched. OWNER and TRAINER rows are not reachable from here.
  async remove(
    ownerId: string,
    gymId: string,
    memberId: string,
    ip: string | undefined,
  ): Promise<void> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);
    if (!isUuid(memberId)) throw memberNotFound();

    const row = await this.prisma.gymMember.findFirst({
      where: { id: memberId, gymId, role: 'MEMBER' },
      select: { id: true, status: true, userId: true },
    });
    if (!row) throw memberNotFound();

    const notRemovable = () =>
      conflict(
        'MEMBER_NOT_REMOVABLE',
        'Only active or invited members can be removed. Pending requests are handled with approve or reject.',
      );
    if (row.status !== 'ACTIVE' && row.status !== 'INVITED') throw notRemovable();

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Only succeeds while the row is still ACTIVE or INVITED, so competing requests cannot both win.
      const result = await tx.gymMember.updateMany({
        where: { id: row.id, gymId, role: 'MEMBER', status: { in: ['ACTIVE', 'INVITED'] } },
        data: { status: 'REMOVED', removedAt: now, whatsappConsent: false, whatsappConsentAt: null },
      });
      if (result.count !== 1) throw notRemovable();

      if (row.userId) {
        await tx.consentRecord.updateMany({
          where: { userId: row.userId, gymId, type: 'WHATSAPP', revokedAt: null },
          data: { revokedAt: now },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: 'gym_member.removed',
          entityType: 'gym_member',
          entityId: row.id,
          metadata: { previousStatus: row.status },
          ip: ip ?? null,
        },
      });
    });
  }

  private async loadDetail(gymId: string, memberId: string): Promise<MemberDetail> {
    if (!isUuid(memberId)) throw memberNotFound();
    const row = await this.prisma.gymMember.findFirst({
      where: { id: memberId, gymId, role: 'MEMBER' },
      select: MEMBER_SELECT,
    });
    if (!row) throw memberNotFound();
    return toMemberDetail(row);
  }
}