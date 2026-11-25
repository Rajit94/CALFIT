import { Injectable } from '@nestjs/common';
import { addDays } from '../common/date-only.js';
import { fromDateOnly, istDateString } from '../common/profile/age.js';
import { isUuid } from '../common/uuid.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { conflict } from '../gyms/gym-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {

  fieldError,
  memberNotFound,
  membershipNotFound,
  planNotFound,
} from './fee-errors.js';
import { loadFeeDetail } from './fee-reader.js';
import { FEE_DETAIL_SELECT, FEE_SELECT } from './fee-select.js';
import { feeStatusWhere } from './fee-status.js';
import { toFeeItem, toMyFeeItem } from './fee-view.js';
import type { FeeDetail, FeeItem, MyFeeItem } from './fee-view.js';
import {
  DUE_BEFORE_START_DAYS,
  START_AHEAD_DAYS,
  START_BACKDATE_DAYS,
} from './fees.constants.js';
import type { AssignFeeDto, ListFeesQuery } from './fees.schemas.js';
import { fromPaise, toPaise } from './money.js';



@Injectable()
export class FeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  // Creates ONE fee cycle. A renewal is the same action with the next start date.
  async assign(
    ownerId: string,
    gymId: string,
    memberId: string,
    dto: AssignFeeDto,
    ip: string | undefined,
  ): Promise<FeeDetail> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);
    if (!isUuid(memberId)) throw memberNotFound();

    const member = await this.prisma.gymMember.findFirst({
      where: { id: memberId, gymId, role: 'MEMBER' },
      select: { id: true, status: true },
    });
    if (!member) throw memberNotFound();
    if (member.status !== 'ACTIVE' && member.status !== 'INVITED') {
      throw conflict(
        'MEMBER_NOT_BILLABLE',
        'Fees can only be assigned to active or invited members. Pending requests must be approved first, and removed members get no new cycles.',
      );
    }

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: dto.planId, gymId },
      select: { id: true, name: true, durationDays: true, price: true, isActive: true },
    });
    if (!plan) throw planNotFound();
    if (!plan.isActive) throw conflict('PLAN_INACTIVE', 'This plan is no longer active.');

    const today = istDateString();
    if (dto.startDate < addDays(today, -START_BACKDATE_DAYS) || dto.startDate > addDays(today, START_AHEAD_DAYS)) {
      throw fieldError(
        'startDate',
        `The start date must be between ${START_BACKDATE_DAYS} days ago and ${START_AHEAD_DAYS} days from now.`,
      );
    }
    const periodStart = dto.startDate;
    const periodEnd = addDays(periodStart, plan.durationDays - 1);

    const dueDate = dto.dueDate ?? periodStart;
    if (dueDate < addDays(periodStart, -DUE_BEFORE_START_DAYS) || dueDate > periodEnd) {
      throw fieldError(
        'dueDate',
        `The due date must be between ${DUE_BEFORE_START_DAYS} days before the start and the last day of the cycle.`,
      );
    }

    const planPaise = toPaise(plan.price);
    const amountPaise = dto.amount ?? planPaise;
    if (amountPaise !== planPaise && !dto.amountReason) {
      throw fieldError('amountReason', 'Give a reason when the amount differs from the plan price.');
    }

    // No overlapping cycles for the same member. Waived cycles do not count, so a mistaken cycle can be waived and re-assigned.
    const overlap = await this.prisma.memberFee.findFirst({
      where: {
        gymMemberId: member.id,
        status: { in: ['PENDING', 'PARTIAL', 'PAID', 'OVERDUE'] },
        periodStart: { lte: fromDateOnly(periodEnd) },
        periodEnd: { gte: fromDateOnly(periodStart) },
      },
      select: { id: true },
    });
    if (overlap) {
      throw conflict('FEE_PERIOD_OVERLAP', 'This member already has a fee that covers some of these days.');
    }

    const feeId = await this.prisma.$transaction(async (tx) => {
      const fee = await tx.memberFee.create({
        data: {
          gymId,
          gymMemberId: member.id,
          planId: plan.id,
          periodStart: fromDateOnly(periodStart),
          periodEnd: fromDateOnly(periodEnd),
          dueDate: fromDateOnly(dueDate),
          amount: fromPaise(amountPaise),
          amountPaid: 0,
          status: 'PENDING',
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: 'fee.assigned',
          entityType: 'member_fee',
          entityId: fee.id,
          metadata: {
            planId: plan.id,
            planName: plan.name,
            amount: fromPaise(amountPaise),
            planPrice: fromPaise(planPaise),
            reason: amountPaise !== planPaise ? (dto.amountReason ?? null) : null, // discount reasons live here: there is no column
            periodStart,
            periodEnd,
            dueDate,
          },
          ip: ip ?? null,
        },
      });
      return fee.id;
    });
    return loadFeeDetail(this.prisma, gymId, feeId, today);
  }

  async list(
    ownerId: string,
    gymId: string,
    query: ListFeesQuery,
  ): Promise<{ items: FeeItem[]; nextCursor: string | null }> {
    await this.access.requireOwner(ownerId, gymId);
    const today = istDateString();
    const todayDate = fromDateOnly(today);

    if (query.cursor) {
      const known = await this.prisma.memberFee.findFirst({
        where: { id: query.cursor, gymId },
        select: { id: true },
      });
      if (!known) throw fieldError('cursor', 'Invalid cursor');
    }

    const and: Array<Record<string, unknown>> = [];
    if (query.status) and.push(feeStatusWhere(query.status, todayDate));
    if (query.dueFrom !== undefined || query.dueTo !== undefined) {
      and.push({
        dueDate: {
          ...(query.dueFrom !== undefined ? { gte: fromDateOnly(query.dueFrom) } : {}),
          ...(query.dueTo !== undefined ? { lte: fromDateOnly(query.dueTo) } : {}),
        },
      });
    }
    const where: Record<string, unknown> = {
      gymId,
      ...(query.memberId ? { gymMemberId: query.memberId } : {}),
      ...(and.length > 0 ? { AND: and } : {}),
    };

    const rows = await this.prisma.memberFee.findMany({
      where: where as never,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: FEE_SELECT,
    });

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toFeeItem(row, today)),
      nextCursor: rows.length > query.limit && last ? last.id : null,
    };
  }

  async get(ownerId: string, gymId: string, feeId: string): Promise<FeeDetail> {
    await this.access.requireOwner(ownerId, gymId);
    return loadFeeDetail(this.prisma, gymId, feeId, istDateString());
  }

  // A member's own fees and receipts. Removed and merely invited people do not have access to the gym.
  async myFees(userId: string, gymId: string): Promise<{ items: MyFeeItem[] }> {
    const access = await this.access.requireMember(userId, gymId);
    if (!access.roles.includes('MEMBER')) throw membershipNotFound();

    const row = await this.prisma.gymMember.findFirst({
      where: { gymId, userId, role: 'MEMBER', status: 'ACTIVE' },
      select: { id: true },
    });
    if (!row) throw membershipNotFound();

    const today = istDateString();
    const fees = await this.prisma.memberFee.findMany({
      where: { gymMemberId: row.id },
      orderBy: [{ periodStart: 'desc' }, { id: 'asc' }],
      take: 100,
      select: FEE_DETAIL_SELECT,
    });
    return { items: fees.map((fee) => toMyFeeItem(fee, today)) };
  }
}