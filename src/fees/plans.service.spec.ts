import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeFeeDb } from '../../test/support/fake-fee-db.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { PlansService } from './plans.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

function setup() {
  const db = makeFeeDb();
  const owner = db.seed.user();
  const gym = db.seed.gym({ code: 'K7M2QX', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  const service = new PlansService(db.prisma as never, new GymAccessService(db.prisma as never));
  const create = (over: Record<string, unknown> = {}) =>
    service.create(owner.id, gym.id, { name: 'Monthly', durationDays: 30, price: 50000, ...over } as never, '1.2.3.4');
  return { db, owner, gym, sub, service, create };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PlansService.create', () => {
  it('stores the plan with the price in rupees and audits it', async () => {
    const { db, gym, create } = setup();
    const plan = await create({ description: 'All equipment', price: 49950 });
    expect(plan).toMatchObject({ name: 'Monthly', description: 'All equipment', durationDays: 30, price: 499.5, isActive: true });
    expect(db.state.plans).toEqual([expect.objectContaining({ gymId: gym.id, price: 499.5 })]);
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'plan.created', entityId: plan.planId, metadata: { name: 'Monthly', durationDays: 30, price: 499.5 }, ip: '1.2.3.4',
    });
  });

  it('refuses a second plan with the same name, ignoring case, but allows it in another gym', async () => {
    const { db, owner, create } = setup();
    await create({ name: 'Monthly' });
    expect(await failure(create({ name: 'MONTHLY' }))).toEqual({ status: 409, code: 'PLAN_NAME_TAKEN' });

    const otherGym = db.seed.gym({ code: 'OTHER2' });
    db.seed.sub({ gymId: otherGym.id });
    db.seed.member({ gymId: otherGym.id, userId: owner.id, role: 'OWNER' });
    const service = new PlansService(db.prisma as never, new GymAccessService(db.prisma as never));
    await expect(service.create(owner.id, otherGym.id, { name: 'Monthly', durationDays: 30, price: 50000 } as never, undefined)).resolves.toBeDefined();
  });

  it('limits a gym to 50 plans', async () => {
    const { db, gym, create } = setup();
    for (let i = 0; i < 50; i++) db.seed.plan({ gymId: gym.id, name: `Plan ${i}` });
    expect(await failure(create({ name: 'One too many' }))).toEqual({ status: 409, code: 'PLAN_LIMIT_REACHED' });
  });

  it('is for owners only, and refused in read-only and suspended gyms', async () => {
    const { db, gym, sub, service, create } = setup();
    const member = db.seed.user();
    db.seed.member({ gymId: gym.id, userId: member.id, role: 'MEMBER' });
    expect(await failure(service.create(member.id, gym.id, { name: 'Sneaky', durationDays: 30, price: 50000 } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(create({ name: 'Late' }))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    sub.status = 'TRIAL';
    gym.status = 'SUSPENDED';
    expect(await failure(create({ name: 'Late' }))).toEqual({ status: 403, code: 'GYM_SUSPENDED' });
  });
});

describe('PlansService.list', () => {
  it('lists active plans by default, shortest first, and inactive ones on request', async () => {
    const { db, owner, gym, service } = setup();
    db.seed.plan({ gymId: gym.id, name: 'Yearly', durationDays: 365, price: 5000 });
    db.seed.plan({ gymId: gym.id, name: 'Monthly', durationDays: 30, price: 500 });
    db.seed.plan({ gymId: gym.id, name: 'Weekly', durationDays: 7, price: 150 });
    db.seed.plan({ gymId: gym.id, name: 'Old', durationDays: 30, price: 400, isActive: false });
    const other = db.seed.gym({ code: 'OTHER2' });
    db.seed.plan({ gymId: other.id, name: 'Foreign' });

    expect((await service.list(owner.id, gym.id, false)).items.map((p) => p.name)).toEqual(['Weekly', 'Monthly', 'Yearly']);
    expect((await service.list(owner.id, gym.id, true)).items.map((p) => p.name)).toEqual(['Weekly', 'Monthly', 'Yearly', 'Old']);
  });

  it('is for owners only, and works in a read-only gym', async () => {
    const { db, owner, gym, sub, service } = setup();
    const member = db.seed.user();
    db.seed.member({ gymId: gym.id, userId: member.id, role: 'MEMBER' });
    expect(await failure(service.list(member.id, gym.id, false))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    expect(await failure(service.list(db.seed.user().id, gym.id, false))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    sub.status = 'READ_ONLY';
    await expect(service.list(owner.id, gym.id, false)).resolves.toBeDefined();
  });
});

describe('PlansService.update', () => {
  it('changes only the fields sent, and records a price change', async () => {
    const { db, owner, gym, service, create } = setup();
    const plan = await create();
    const updated = await service.update(owner.id, gym.id, plan.planId, { price: 45000, description: null } as never, '9.9.9.9');
    expect(updated).toMatchObject({ name: 'Monthly', price: 450, description: null, durationDays: 30 });
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'plan.updated', metadata: { fields: ['description', 'price'], priceFrom: 500, priceTo: 450 }, ip: '9.9.9.9',
    });
  });

  it('deactivates a plan', async () => {
    const { owner, gym, service, create } = setup();
    const plan = await create();
    expect((await service.update(owner.id, gym.id, plan.planId, { isActive: false } as never, undefined)).isActive).toBe(false);
  });

  it('allows keeping the same name, but not taking another plan’s name', async () => {
    const { owner, gym, service, create } = setup();
    const monthly = await create({ name: 'Monthly' });
    await create({ name: 'Weekly', durationDays: 7 });
    await expect(service.update(owner.id, gym.id, monthly.planId, { name: 'monthly' } as never, undefined)).resolves.toBeDefined();
    expect(await failure(service.update(owner.id, gym.id, monthly.planId, { name: 'WEEKLY' } as never, undefined))).toEqual({ status: 409, code: 'PLAN_NAME_TAKEN' });
  });

  it('answers 404 for unknown ids, bad ids and plans of another gym', async () => {
    const { db, owner, gym, service } = setup();
    const foreign = db.seed.plan({ gymId: db.seed.gym({ code: 'OTHER2' }).id });
    for (const id of ['33333333-3333-4333-8333-333333333333', 'not-a-uuid', foreign.id as string]) {
      expect(await failure(service.update(owner.id, gym.id, id, { isActive: false } as never, undefined))).toEqual({ status: 404, code: 'PLAN_NOT_FOUND' });
    }
  });

  it('is for owners only, and refused in read-only gyms', async () => {
    const { db, owner, gym, sub, service, create } = setup();
    const plan = await create();
    const member = db.seed.user();
    db.seed.member({ gymId: gym.id, userId: member.id, role: 'MEMBER' });
    expect(await failure(service.update(member.id, gym.id, plan.planId, { isActive: false } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(service.update(owner.id, gym.id, plan.planId, { isActive: false } as never, undefined))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
  });
});