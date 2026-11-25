import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeFeeDb } from '../../test/support/fake-fee-db.js';
import type { Row } from '../../test/support/fake-fee-db.js';
import { addDays } from '../common/date-only.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { FeesService } from './fees.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const TODAY = '2026-11-04'; // in India
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function setup() {
  const db = makeFeeDb();
  const owner = db.seed.user();
  const gym = db.seed.gym({ code: 'K7M2QX', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  const plan = db.seed.plan({ gymId: gym.id, name: 'Monthly', durationDays: 30, price: 500 });
  const service = new FeesService(db.prisma as never, new GymAccessService(db.prisma as never));

  let counter = 0;
  const member = (status = 'ACTIVE', over: Row = {}) => {
    const user = db.seed.user({ name: `Member ${++counter}` });
    const row = db.seed.member({ gymId: gym.id, userId: user.id, role: 'MEMBER', status, joinedAt: NOW, ...over });
    return { user, row };
  };
  const assign = (memberId: string, over: Record<string, unknown> = {}) =>
    service.assign(owner.id, gym.id, memberId, { planId: plan.id, startDate: TODAY, ...over } as never, '1.2.3.4');
  const query = (over: Row = {}) => ({ limit: 50, ...over }) as never;
  return { db, owner, gym, sub, plan, service, member, assign, query };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FeesService.assign', () => {
  it('creates one cycle that ends after the plan duration, due on the start date, at the plan price', async () => {
    const { db, gym, plan, member, assign } = setup();
    const { row } = member();
    const fee = await assign(row.id as string);

    expect(fee).toMatchObject({
      memberId: row.id, periodStart: TODAY, periodEnd: '2026-12-03', dueDate: TODAY,
      amount: 500, amountPaid: 0, balance: 500, status: 'PENDING', plan: { planId: plan.id, name: 'Monthly' }, payments: [],
    });
    expect(db.state.fees).toHaveLength(1);
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'fee.assigned', gymId: gym.id, entityId: fee.feeId, ip: '1.2.3.4',
      metadata: { planId: plan.id, amount: 500, planPrice: 500, reason: null, periodEnd: '2026-12-03' },
    });
  });

  it('accepts a later due date, and one up to 30 days before the start', async () => {
    const { member, assign } = setup();
    expect((await assign(member().row.id as string, { dueDate: '2026-11-10' })).dueDate).toBe('2026-11-10');
    expect((await assign(member().row.id as string, { startDate: '2026-11-20', dueDate: addDays('2026-11-20', -30) })).dueDate).toBe('2026-10-21');
  });

  it('refuses a due date outside the window', async () => {
    const { member, assign } = setup();
    const { row } = member();
    for (const dueDate of [addDays(TODAY, -31), addDays('2026-12-03', 1)]) {
      const error = await failure(assign(row.id as string, { dueDate }));
      expect(error).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });

  it('refuses a start date outside the window, and accepts the limits', async () => {
    const { member, assign } = setup();
    expect((await failure(assign(member().row.id as string, { startDate: addDays(TODAY, -91) }))).code).toBe('VALIDATION_FAILED');
    expect((await failure(assign(member().row.id as string, { startDate: addDays(TODAY, 366) }))).code).toBe('VALIDATION_FAILED');
    await expect(assign(member().row.id as string, { startDate: addDays(TODAY, -90) })).resolves.toBeDefined();
    await expect(assign(member().row.id as string, { startDate: addDays(TODAY, 365) })).resolves.toBeDefined();
  });

  it('needs a reason for a different amount, which is kept in the audit log', async () => {
    const { db, member, assign } = setup();
    const { row } = member();
    expect(await failure(assign(row.id as string, { amount: 40000 }))).toEqual({ status: 400, code: 'VALIDATION_FAILED' });

    const fee = await assign(row.id as string, { amount: 40000, amountReason: 'Student discount' });
    expect(fee.amount).toBe(400);
    expect(db.state.audits.at(-1)!.metadata).toMatchObject({ amount: 400, planPrice: 500, reason: 'Student discount' });

    const same = await assign(member().row.id as string, { amount: 50000 });
    expect(same.amount).toBe(500);
  });

  it('bills active and invited members, but not pending, removed or rejected ones', async () => {
    const { member, assign } = setup();
    await expect(assign(member('ACTIVE').row.id as string)).resolves.toBeDefined();
    await expect(assign(member('INVITED', { userId: null, invitedPhone: '+919000000001' }).row.id as string)).resolves.toBeDefined();
    for (const status of ['PENDING', 'REMOVED', 'REJECTED']) {
      expect(await failure(assign(member(status).row.id as string))).toEqual({ status: 409, code: 'MEMBER_NOT_BILLABLE' });
    }
  });

  it('answers 404 for unknown members, bad ids, other gyms and the owner’s own row', async () => {
    const { db, owner, gym, service, plan } = setup();
    const stray = db.seed.member({ gymId: db.seed.gym({ code: 'OTHER2' }).id, userId: db.seed.user().id, role: 'MEMBER' });
    const ownerRow = db.state.members.find((m) => m.role === 'OWNER')!;
    for (const id of ['33333333-3333-4333-8333-333333333333', 'not-a-uuid', stray.id as string, ownerRow.id as string]) {
      expect(await failure(service.assign(owner.id, gym.id, id, { planId: plan.id, startDate: TODAY } as never, undefined))).toEqual({ status: 404, code: 'MEMBER_NOT_FOUND' });
    }
  });

  it('refuses unknown, foreign and inactive plans', async () => {
    const { db, member, assign, plan } = setup();
    const { row } = member();
    const foreign = db.seed.plan({ gymId: db.seed.gym({ code: 'OTHER2' }).id });
    expect(await failure(assign(row.id as string, { planId: '33333333-3333-4333-8333-333333333333' }))).toEqual({ status: 404, code: 'PLAN_NOT_FOUND' });
    expect(await failure(assign(row.id as string, { planId: foreign.id }))).toEqual({ status: 404, code: 'PLAN_NOT_FOUND' });
    plan.isActive = false;
    expect(await failure(assign(row.id as string))).toEqual({ status: 409, code: 'PLAN_INACTIVE' });
  });

  it('refuses overlapping cycles, allows back-to-back ones, and ignores waived ones', async () => {
    const { db, member, assign } = setup();
    const { row } = member();
    await assign(row.id as string); // 2026-11-04 .. 2026-12-03

    expect(await failure(assign(row.id as string, { startDate: '2026-12-03' }))).toEqual({ status: 409, code: 'FEE_PERIOD_OVERLAP' });
    expect(await failure(assign(row.id as string, { startDate: '2026-10-10' }))).toEqual({ status: 409, code: 'FEE_PERIOD_OVERLAP' });
    await expect(assign(row.id as string, { startDate: '2026-12-04' })).resolves.toBeDefined();
    await expect(assign(row.id as string, { startDate: '2026-10-05' })).resolves.toBeDefined(); // ends 2026-11-03

    db.state.fees.filter((f) => f.gymMemberId === row.id).forEach((f) => (f.status = 'WAIVED'));
    await expect(assign(row.id as string, { startDate: '2026-11-15' })).resolves.toBeDefined();
  });

  it('does not overlap cycles of different members', async () => {
    const { member, assign } = setup();
    await assign(member().row.id as string);
    await expect(assign(member().row.id as string)).resolves.toBeDefined();
  });

  it('is for owners only, and refused in read-only and suspended gyms', async () => {
    const { gym, sub, plan, service, member, assign } = setup();
    const { user, row } = member();
    expect(await failure(service.assign(user.id, gym.id, row.id as string, { planId: plan.id, startDate: TODAY } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(assign(row.id as string))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    sub.status = 'TRIAL';
    gym.status = 'SUSPENDED';
    expect(await failure(assign(row.id as string))).toEqual({ status: 403, code: 'GYM_SUSPENDED' });
  });
});

describe('FeesService.list', () => {
  function withFees() {
    const env = setup();
    const make = (label: string, over: Row, memberStatus = 'ACTIVE') => {
      const { row, user } = env.member(memberStatus);
      const fee = env.db.seed.fee({ gymId: env.gym.id, gymMemberId: row.id, planId: env.plan.id, ...over });
      return { label, row, user, fee };
    };
    const waived = make('waived', { dueDate: d('2026-09-15'), status: 'WAIVED', amountPaid: 100 });
    const paid = make('paid', { dueDate: d('2026-10-01'), status: 'PAID', amountPaid: 500 });
    const overdue = make('overdue', { dueDate: d('2026-10-20') });
    const overduePartial = make('overduePartial', { dueDate: d('2026-10-25'), status: 'PARTIAL', amountPaid: 100 });
    const pending = make('pending', { dueDate: d('2026-11-10') });
    const partial = make('partial', { dueDate: d('2026-11-12'), status: 'PARTIAL', amountPaid: 200 });
    return { ...env, waived, paid, overdue, overduePartial, pending, partial };
  }
  const labels = (res: { items: Array<{ feeId: string }> }, all: Array<{ label: string; fee: Row }>) =>
    res.items.map((i) => all.find((a) => a.fee.id === i.feeId)!.label);

  it('lists fees by due date, oldest first, with the effective status', async () => {
    const env = withFees();
    const all = [env.waived, env.paid, env.overdue, env.overduePartial, env.pending, env.partial];
    const res = await env.service.list(env.owner.id, env.gym.id, env.query());
    expect(labels(res, all)).toEqual(['waived', 'paid', 'overdue', 'overduePartial', 'pending', 'partial']);
    expect(res.items.map((i) => i.status)).toEqual(['WAIVED', 'PAID', 'OVERDUE', 'OVERDUE', 'PENDING', 'PARTIAL']);
    expect(res.nextCursor).toBeNull();
  });

  it('filters by effective status', async () => {
    const env = withFees();
    const all = [env.waived, env.paid, env.overdue, env.overduePartial, env.pending, env.partial];
    const by = async (status: string) => labels(await env.service.list(env.owner.id, env.gym.id, env.query({ status })), all);
    expect(await by('OVERDUE')).toEqual(['overdue', 'overduePartial']);
    expect(await by('PENDING')).toEqual(['pending']);
    expect(await by('PARTIAL')).toEqual(['partial']);
    expect(await by('PAID')).toEqual(['paid']);
    expect(await by('WAIVED')).toEqual(['waived']);
  });

  it('filters by member and by a due-date range, and combines them with a status', async () => {
    const env = withFees();
    const all = [env.waived, env.paid, env.overdue, env.overduePartial, env.pending, env.partial];
    const list = async (q: Row) => labels(await env.service.list(env.owner.id, env.gym.id, env.query(q)), all);
    expect(await list({ memberId: env.pending.row.id })).toEqual(['pending']);
    expect(await list({ dueFrom: '2026-10-20', dueTo: '2026-11-10' })).toEqual(['overdue', 'overduePartial', 'pending']);
    expect(await list({ dueFrom: '2026-11-11' })).toEqual(['partial']);
    expect(await list({ status: 'OVERDUE', dueFrom: '2026-10-22' })).toEqual(['overduePartial']);
  });

  it('pages through every fee exactly once, and refuses a cursor from another gym', async () => {
    const env = withFees();
    const all = [env.waived, env.paid, env.overdue, env.overduePartial, env.pending, env.partial];
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await env.service.list(env.owner.id, env.gym.id, env.query({ limit: 2, cursor }));
      seen.push(...labels(res, all));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(seen).toEqual(['waived', 'paid', 'overdue', 'overduePartial', 'pending', 'partial']);

    const otherGym = env.db.seed.gym({ code: 'OTHER2' });
    const stray = env.db.seed.fee({ gymId: otherGym.id, gymMemberId: 'x' });
    expect(await failure(env.service.list(env.owner.id, env.gym.id, env.query({ cursor: stray.id })))).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('shows full phone numbers for active members and masks them for removed ones', async () => {
    const env = setup();
    const active = env.member('ACTIVE');
    const removed = env.member('REMOVED');
    env.db.seed.fee({ gymId: env.gym.id, gymMemberId: active.row.id, dueDate: d('2026-11-10') });
    env.db.seed.fee({ gymId: env.gym.id, gymMemberId: removed.row.id, dueDate: d('2026-11-11') });
    const res = await env.service.list(env.owner.id, env.gym.id, env.query());
    expect(res.items[0]!.member.phone).toBe(active.user.phone);
    expect(res.items[1]!.member.phone).toBeNull();
    expect(res.items[1]!.member.phoneMasked).toMatch(/^\+91\*+\d{4}$/);
    expect(JSON.stringify(res.items[1])).not.toContain(removed.user.phone);
  });

  it('is for owners only, and works in a read-only gym', async () => {
    const env = setup();
    const { user } = env.member();
    expect(await failure(env.service.list(user.id, env.gym.id, env.query()))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    env.sub.status = 'READ_ONLY';
    await expect(env.service.list(env.owner.id, env.gym.id, env.query())).resolves.toBeDefined();
  });
});

describe('FeesService.get', () => {
  it('returns a fee with its payments, and 404 for anything else', async () => {
    const env = setup();
    const { row } = env.member();
    const fee = env.db.seed.fee({ gymId: env.gym.id, gymMemberId: row.id, amountPaid: 100, status: 'PARTIAL' });
    env.db.seed.payment({ memberFeeId: fee.id, gymId: env.gym.id, gymMemberId: row.id, amount: 100 });
    const stray = env.db.seed.fee({ gymId: env.db.seed.gym({ code: 'OTHER2' }).id, gymMemberId: 'x' });

    const detail = await env.service.get(env.owner.id, env.gym.id, fee.id as string);
    expect(detail).toMatchObject({ feeId: fee.id, status: 'PARTIAL', balance: 400 });
    expect(detail.payments).toHaveLength(1);
    for (const id of ['33333333-3333-4333-8333-333333333333', 'not-a-uuid', stray.id as string]) {
      expect(await failure(env.service.get(env.owner.id, env.gym.id, id))).toEqual({ status: 404, code: 'FEE_NOT_FOUND' });
    }
  });
});

describe('FeesService.myFees', () => {
  it('shows a member only their own fees, newest cycle first, with receipts', async () => {
    const env = setup();
    const me = env.member();
    const other = env.member();
    const older = env.db.seed.fee({ gymId: env.gym.id, gymMemberId: me.row.id, periodStart: d('2026-10-01'), periodEnd: d('2026-10-30'), dueDate: d('2026-10-01') });
    const newer = env.db.seed.fee({ gymId: env.gym.id, gymMemberId: me.row.id, periodStart: d('2026-11-04'), amountPaid: 200, status: 'PARTIAL' });
    env.db.seed.fee({ gymId: env.gym.id, gymMemberId: other.row.id });
    env.db.seed.payment({ memberFeeId: newer.id, gymId: env.gym.id, gymMemberId: me.row.id, amount: 200 });

    const res = await env.service.myFees(me.user.id, env.gym.id);
    expect(res.items.map((i) => i.feeId)).toEqual([newer.id, older.id]);
    expect(res.items[0]!.payments).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ status: 'PARTIAL', balance: 300 });
    expect('member' in res.items[0]!).toBe(false);
    expect(JSON.stringify(res)).not.toContain(other.user.phone);
  });

  it('answers MEMBERSHIP_NOT_FOUND for an owner without a member row, and GYM_NOT_FOUND for everyone else', async () => {
    const env = setup();
    expect(await failure(env.service.myFees(env.owner.id, env.gym.id))).toEqual({ status: 404, code: 'MEMBERSHIP_NOT_FOUND' });
    for (const status of ['INVITED', 'REMOVED', 'PENDING']) {
      const { user } = env.member(status);
      expect(await failure(env.service.myFees(user.id, env.gym.id))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    }
    expect(await failure(env.service.myFees(env.db.seed.user().id, env.gym.id))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });

  it('works in a read-only gym', async () => {
    const env = setup();
    const { user } = env.member();
    env.sub.status = 'READ_ONLY';
    await expect(env.service.myFees(user.id, env.gym.id)).resolves.toEqual({ items: [] });
  });
});