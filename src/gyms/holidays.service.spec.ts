import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeGymDb } from '../../test/support/fake-gym-db.js';
import { GymAccessService } from './gym-access.service.js';
import { HolidaysService } from './holidays.service.js';

// "Today" in India is 2026-11-04 for every test.
const NOW = new Date('2026-11-04T10:00:00.000Z');

function setup() {
  const db = makeGymDb();
  const owner = db.seed.user();
  const member = db.seed.user();
  const gym = db.seed.gym();
  const sub = db.seed.sub({ gymId: gym.id });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  db.seed.member({ gymId: gym.id, userId: member.id, role: 'MEMBER' });
  const service = new HolidaysService(db.prisma as never, new GymAccessService(db.prisma as never));
  return { db, owner, member, gym, sub, service };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('HolidaysService.add', () => {
  it('accepts today, a future date and the last allowed day, and audits each', async () => {
    const { db, owner, gym, service } = setup();
    for (const date of ['2026-11-04', '2026-11-14', '2027-11-04']) {
      await expect(service.add(owner.id, gym.id, { date, reason: null } as never, '1.2.3.4')).resolves.toMatchObject({ date });
    }
    expect(db.state.holidays).toHaveLength(3);
    expect(db.state.audits.filter((a) => a.action === 'gym.holiday_added')).toHaveLength(3);
  });

  it('refuses the past and dates more than a year ahead', async () => {
    const { db, owner, gym, service } = setup();
    for (const date of ['2026-11-03', '2020-01-01', '2027-11-05']) {
      expect(await failure(service.add(owner.id, gym.id, { date } as never, undefined))).toEqual({ status: 400, code: 'HOLIDAY_DATE_INVALID' });
    }
    expect(db.state.holidays).toHaveLength(0);
  });

  it('refuses a second holiday on the same date', async () => {
    const { owner, gym, service } = setup();
    await service.add(owner.id, gym.id, { date: '2026-11-14' } as never, undefined);
    expect(await failure(service.add(owner.id, gym.id, { date: '2026-11-14' } as never, undefined))).toEqual({ status: 409, code: 'HOLIDAY_EXISTS' });
  });

  it('is for owners only, and refused in a read-only gym', async () => {
    const { owner, member, gym, sub, service } = setup();
    expect(await failure(service.add(member.id, gym.id, { date: '2026-11-14' } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(service.add(owner.id, gym.id, { date: '2026-11-14' } as never, undefined))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
  });
});

describe('HolidaysService.remove', () => {
  it('removes a future holiday and audits it', async () => {
    const { db, owner, gym, service } = setup();
    const holiday = await service.add(owner.id, gym.id, { date: '2026-11-14' } as never, undefined);
    await service.remove(owner.id, gym.id, holiday.id, '1.2.3.4');
    expect(db.state.holidays).toHaveLength(0);
    expect(db.state.audits.at(-1)).toMatchObject({ action: 'gym.holiday_removed', metadata: { date: '2026-11-14' } });
  });

  it('locks today’s holiday and past holidays', async () => {
    const { owner, gym, service } = setup();
    const today = await service.add(owner.id, gym.id, { date: '2026-11-04' } as never, undefined);
    expect(await failure(service.remove(owner.id, gym.id, today.id, undefined))).toEqual({ status: 409, code: 'HOLIDAY_LOCKED' });

    const later = await service.add(owner.id, gym.id, { date: '2026-11-05' } as never, undefined);
    vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z')); // the holiday is now in the past
    expect((await failure(service.remove(owner.id, gym.id, later.id, undefined))).code).toBe('HOLIDAY_LOCKED');
  });

  it('answers 404 for unknown ids and other gyms’ holidays', async () => {
    const { db, owner, gym, service } = setup();
    expect(await failure(service.remove(owner.id, gym.id, 'not-a-uuid', undefined))).toEqual({ status: 404, code: 'HOLIDAY_NOT_FOUND' });
    const other = db.seed.gym({ code: 'OTHER2' });
    db.seed.sub({ gymId: other.id });
    db.seed.member({ gymId: other.id, userId: owner.id, role: 'OWNER' });
    const foreign = await service.add(owner.id, other.id, { date: '2026-11-20' } as never, undefined);
    expect(await failure(service.remove(owner.id, gym.id, foreign.id, undefined))).toEqual({ status: 404, code: 'HOLIDAY_NOT_FOUND' });
  });
});

describe('HolidaysService.list', () => {
  it('lets any active member read, defaults to the next 365 days, and sorts by date', async () => {
    const { db, owner, member, gym, service } = setup();
    await service.add(owner.id, gym.id, { date: '2026-12-25', reason: 'Christmas' } as never, undefined);
    await service.add(owner.id, gym.id, { date: '2026-11-14', reason: 'Diwali' } as never, undefined);
    const result = await service.list(member.id, gym.id, {});
    expect(result.items.map((i) => [i.date, i.reason])).toEqual([['2026-11-14', 'Diwali'], ['2026-12-25', 'Christmas']]);
    expect(await failure(service.list(db.seed.user().id, gym.id, {}))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });

  it('honours from and to, and rejects a reversed range', async () => {
    const { owner, gym, service } = setup();
    await service.add(owner.id, gym.id, { date: '2026-11-14' } as never, undefined);
    await service.add(owner.id, gym.id, { date: '2026-12-25' } as never, undefined);
    expect((await service.list(owner.id, gym.id, { from: '2026-12-01', to: '2026-12-31' })).items).toHaveLength(1);
    expect((await failure(service.list(owner.id, gym.id, { from: '2026-12-31', to: '2026-12-01' }))).code).toBe('VALIDATION_FAILED');
  });
});