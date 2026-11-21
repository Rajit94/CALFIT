import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDays } from '../common/date-only.js';
import { fromDateOnly, istDateString, toDateOnly } from '../common/profile/age.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { isUuid } from '../common/uuid.js';
import { issuesToException } from '../common/validation/validation-pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GymAccessService } from './gym-access.service.js';
import { conflict } from './gym-errors.js';
import { MAX_HOLIDAY_DAYS_AHEAD } from './gym.constants.js';
import type { AddHolidayDto } from './gyms.schemas.js';

export interface HolidayItem {
  id: string;
  date: string;
  reason: string | null;
}

const holidayNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'HOLIDAY_NOT_FOUND', message: 'Holiday not found.' });

// A holiday never breaks a streak. History is protected: nothing in the past can be added or removed,
// because that would silently rewrite people's streaks.
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  async list(
    userId: string,
    gymId: string,
    range: { from?: string | undefined; to?: string | undefined },
  ): Promise<{ items: HolidayItem[] }> {
    await this.access.requireMember(userId, gymId);
    const from = range.from ?? istDateString();
    const to = range.to ?? addDays(from, MAX_HOLIDAY_DAYS_AHEAD);
    if (to < from) {
      throw issuesToException([{ message: '"to" must not be before "from"', path: ['to'] }]);
    }

    const rows = await this.prisma.gymHoliday.findMany({
      where: { gymId, date: { gte: fromDateOnly(from), lte: fromDateOnly(to) } },
      orderBy: { date: 'asc' },
      take: 400,
      select: { id: true, date: true, reason: true },
    });
    return {
      items: rows.map((r) => ({ id: r.id, date: toDateOnly(r.date), reason: r.reason })),
    };
  }

  async add(
    ownerId: string,
    gymId: string,
    dto: AddHolidayDto,
    ip: string | undefined,
  ): Promise<HolidayItem> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);

    const today = istDateString();
    if (dto.date < today || dto.date > addDays(today, MAX_HOLIDAY_DAYS_AHEAD)) {
      throw new BadRequestException({
        code: 'HOLIDAY_DATE_INVALID',
        message: `A holiday must fall between today and ${MAX_HOLIDAY_DAYS_AHEAD} days from now.`,
      });
    }

    try {
      const created = await this.prisma.gymHoliday.create({
        data: { gymId, date: fromDateOnly(dto.date), reason: dto.reason ?? null },
        select: { id: true, date: true, reason: true },
      });
      await this.prisma.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: 'gym.holiday_added',
          entityType: 'gym_holiday',
          entityId: created.id,
          metadata: { date: dto.date },
          ip: ip ?? null,
        },
      });
      return { id: created.id, date: toDateOnly(created.date), reason: created.reason };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('HOLIDAY_EXISTS', 'A holiday is already declared for this date.');
      }
      throw error;
    }
  }

  async remove(
    ownerId: string,
    gymId: string,
    holidayId: string,
    ip: string | undefined,
  ): Promise<void> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);
    if (!isUuid(holidayId)) throw holidayNotFound();

    const holiday = await this.prisma.gymHoliday.findFirst({
      where: { id: holidayId, gymId },
      select: { id: true, date: true },
    });
    if (!holiday) throw holidayNotFound();

    const date = toDateOnly(holiday.date);
    if (date <= istDateString()) {
      throw conflict('HOLIDAY_LOCKED', 'Only holidays after today can be removed.');
    }

    await this.prisma.gymHoliday.delete({ where: { id: holiday.id } });
    await this.prisma.auditLog.create({
      data: {
        actorId: ownerId,
        gymId,
        action: 'gym.holiday_removed',
        entityType: 'gym_holiday',
        entityId: holiday.id,
        metadata: { date },
        ip: ip ?? null,
      },
    });
  }
}