import { Injectable } from '@nestjs/common';
import { isUuid } from '../common/uuid.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { conflict } from '../gyms/gym-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { planNotFound } from './fee-errors.js';
import { MAX_PLANS_PER_GYM } from './fees.constants.js';
import type { CreatePlanDto, UpdatePlanDto } from './fees.schemas.js';
import { fromPaise, toPaise } from './money.js';

export interface PlanItem {
  planId: string;
  name: string;
  description: string | null;
  durationDays: number;
  price: number;
  isActive: boolean;
  createdAt: string;
}

const PLAN_SELECT = {
  id: true,
  name: true,
  description: true,
  durationDays: true,
  price: true,
  isActive: true,
  createdAt: true,
} as const;

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  durationDays: number;
  price: unknown;
  isActive: boolean;
  createdAt: Date;
}

export function toPlanItem(row: PlanRow): PlanItem {
  return {
    planId: row.id,
    name: row.name,
    description: row.description,
    durationDays: row.durationDays,
    price: fromPaise(toPaise(row.price)),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

// Plans are never deleted: an old fee may point at one. They are deactivated instead.
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  async list(ownerId: string, gymId: string, includeInactive: boolean): Promise<{ items: PlanItem[] }> {
    await this.access.requireOwner(ownerId, gymId);
    const rows = await this.prisma.membershipPlan.findMany({
      where: { gymId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ isActive: 'desc' }, { durationDays: 'asc' }, { name: 'asc' }],
      take: 100,
      select: PLAN_SELECT,
    });
    return { items: rows.map(toPlanItem) };
  }

  async create(
    ownerId: string,
    gymId: string,
    dto: CreatePlanDto,
    ip: string | undefined,
  ): Promise<PlanItem> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);

    const total = await this.prisma.membershipPlan.count({ where: { gymId } });
    if (total >= MAX_PLANS_PER_GYM) {
      throw conflict('PLAN_LIMIT_REACHED', `A gym can have up to ${MAX_PLANS_PER_GYM} plans. Deactivate or reuse an existing one.`);
    }
    const duplicate = await this.prisma.membershipPlan.findFirst({
      where: { gymId, name: { equals: dto.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (duplicate) throw conflict('PLAN_NAME_TAKEN', 'You already have a plan with this name.');

    const created = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.membershipPlan.create({
        data: {
          gymId,
          name: dto.name,
          description: dto.description ?? null,
          durationDays: dto.durationDays,
          price: fromPaise(dto.price),
        },
        select: PLAN_SELECT,
      });
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: 'plan.created',
          entityType: 'membership_plan',
          entityId: plan.id,
          metadata: { name: dto.name, durationDays: dto.durationDays, price: fromPaise(dto.price) },
          ip: ip ?? null,
        },
      });
      return plan;
    });
    return toPlanItem(created);
  }

  async update(
    ownerId: string,
    gymId: string,
    planId: string,
    dto: UpdatePlanDto,
    ip: string | undefined,
  ): Promise<PlanItem> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);
    if (!isUuid(planId)) throw planNotFound();

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, gymId },
      select: PLAN_SELECT,
    });
    if (!plan) throw planNotFound();

    if (dto.name !== undefined) {
      const duplicate = await this.prisma.membershipPlan.findFirst({
        where: { gymId, name: { equals: dto.name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (duplicate && duplicate.id !== planId) {
        throw conflict('PLAN_NAME_TAKEN', 'You already have a plan with this name.');
      }
    }
const previousPrice = fromPaise(toPaise(plan.price));
    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.durationDays !== undefined ? { durationDays: dto.durationDays } : {}),
      ...(dto.price !== undefined ? { price: fromPaise(dto.price) } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.membershipPlan.update({ where: { id: planId }, data, select: PLAN_SELECT });
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: 'plan.updated',
          entityType: 'membership_plan',
          entityId: planId,
          metadata: {
            fields: Object.keys(data),
            ...(dto.price !== undefined
              ? { priceFrom: previousPrice, priceTo: fromPaise(dto.price) }
              : {}),
          },
          ip: ip ?? null,
        },
      });
      return row;
    });
    return toPlanItem(updated);
  }
}