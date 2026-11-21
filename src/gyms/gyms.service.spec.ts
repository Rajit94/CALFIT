import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeGymDb } from '../../test/support/fake-gym-db.js';
import { ParentalConsentPolicy } from '../common/profile/parental-consent.policy.js';
import { GymAccessService } from './gym-access.service.js';
import { GymsService } from './gyms.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const body = (over: Record<string, unknown> = {}) =>
  ({ name: "Gold's Gym", city: 'Jabalpur', latitude: 23.1815, longitude: 79.9864, ...over }) as never;

function setup() {
  const db = makeGymDb();
  const access = new GymAccessService(db.prisma as never);
  const policy = new ParentalConsentPolicy(db.prisma as never);
  const service = new GymsService(db.prisma as never, access, policy);
  return { db, service, user: db.seed.user() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GymsService.create', () => {
  it('creates the gym, the owner membership, a two-month trial and default settings together', async () => {
    const { db, service, user } = setup();
    const detail = await service.create(user.id, body({ description: 'Best gym', checkInRadiusM: 200 }), '1.2.3.4');

    const gym = db.state.gyms[0]!;
    expect(gym).toMatchObject({ name: "Gold's Gym", city: 'Jabalpur', checkInRadiusM: 200, createdById: user.id });
    expect(gym.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(gym.qrSecret.length).toBeGreaterThanOrEqual(40);

    expect(db.state.members).toHaveLength(1);
    expect(db.state.members[0]).toMatchObject({ gymId: gym.id, userId: user.id, role: 'OWNER', status: 'ACTIVE', approvedById: user.id });

    expect(db.state.subs[0]).toMatchObject({ gymId: gym.id, status: 'TRIAL', pricePerMonth: 499, monthlyMessageLimit: 1000 });
    expect(db.state.subs[0]!.trialStartsAt.toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(db.state.subs[0]!.trialEndsAt.toISOString()).toBe('2027-01-04T10:00:00.000Z');
    expect(db.state.settings).toEqual([expect.objectContaining({ gymId: gym.id })]);
    expect(db.state.audits).toEqual([expect.objectContaining({ action: 'gym.created', gymId: gym.id, ip: '1.2.3.4' })]);

    expect(detail).toMatchObject({ id: gym.id, myRole: 'OWNER', code: gym.code, pendingJoinRequests: 0 });
    expect(detail.subscription).toMatchObject({ status: 'TRIAL', trialDaysLeft: 61, pricePerMonth: 499, monthlyMessageLimit: 1000 });
    expect(JSON.stringify(detail)).not.toContain('qrSecret');
  });

  it('uses the default check-in radius', async () => {
    const { db, service, user } = setup();
    await service.create(user.id, body(), undefined);
    expect(db.state.gyms[0]!.checkInRadiusM).toBe(150);
  });

  it('needs a completed profile and an adult owner', async () => {
    const incomplete = setup();
    incomplete.user.profileCompletedAt = null;
    expect(await failure(incomplete.service.create(incomplete.user.id, body(), undefined))).toEqual({ status: 409, code: 'PROFILE_NOT_COMPLETED' });

    const minor = setup();
    minor.user.dateOfBirth = new Date('2011-03-10T00:00:00.000Z');
    expect(await failure(minor.service.create(minor.user.id, body(), undefined))).toEqual({ status: 403, code: 'GYM_OWNER_MUST_BE_ADULT' });
    expect(minor.db.state.gyms).toHaveLength(0);
  });

  it('allows an owner who turned 18 today', async () => {
    const { service, user } = setup();
    user.dateOfBirth = new Date('2008-11-04T00:00:00.000Z');
    await expect(service.create(user.id, body(), undefined)).resolves.toBeDefined();
  });

  it('limits a person to three gyms', async () => {
    const { db, service, user } = setup();
    for (let i = 0; i < 3; i++) await service.create(user.id, body({ name: `Gym number ${i}` }), undefined);
    expect(await failure(service.create(user.id, body(), undefined))).toEqual({ status: 403, code: 'GYM_LIMIT_REACHED' });
    expect(db.state.gyms).toHaveLength(3);
    // A different person is not affected.
    await expect(service.create(db.seed.user().id, body(), undefined)).resolves.toBeDefined();
  });

  it('retries when the generated code is already taken, and gives up after five attempts', async () => {
    const retry = setup();
    retry.db.state.forcedCodeCollisions = 2;
    await retry.service.create(retry.user.id, body(), undefined);
    expect(retry.db.state.gyms).toHaveLength(1);

    const stuck = setup();
    stuck.db.state.forcedCodeCollisions = 99;
    expect((await failure(stuck.service.create(stuck.user.id, body(), undefined))).status).toBe(500);
    expect(stuck.db.state.gyms).toHaveLength(0);
  });
});

describe('GymsService.getForUser and update', () => {
  async function ownedGym() {
    const env = setup();
    const detail = await env.service.create(env.user.id, body(), undefined);
    return { ...env, gymId: detail.id };
  }

  it('hides the code, the subscription and the pending count from non-owners', async () => {
    const { db, service, gymId } = await ownedGym();
    const member = db.seed.user();
    db.seed.member({ gymId, userId: member.id, role: 'MEMBER' });
    const detail = await service.getForUser(member.id, gymId);
    expect(detail.myRole).toBe('MEMBER');
    for (const key of ['code', 'subscription', 'pendingJoinRequests']) expect(key in detail).toBe(false);
  });

  it('counts pending join requests for the owner', async () => {
    const { db, service, user, gymId } = await ownedGym();
    db.seed.member({ gymId, userId: db.seed.user().id, role: 'MEMBER', status: 'PENDING' });
    db.seed.member({ gymId, userId: db.seed.user().id, role: 'MEMBER', status: 'PENDING' });
    expect((await service.getForUser(user.id, gymId)).pendingJoinRequests).toBe(2);
  });

  it('updates only the fields sent and records which fields changed', async () => {
    const { db, service, user, gymId } = await ownedGym();
    const detail = await service.update(
      user.id, gymId,
      { name: 'New Name', description: null, latitude: 10, longitude: 20, timings: { mon: [['06:00', '10:00']] } } as never,
      '9.9.9.9',
    );
    expect(detail).toMatchObject({ name: 'New Name', description: null, latitude: 10, longitude: 20 });
    expect(detail.city).toBe('Jabalpur');
    const audit = db.state.audits.find((a) => a.action === 'gym.updated')!;
    expect(audit.metadata.fields).toEqual(['name', 'description', 'latitude', 'longitude', 'timings']);
    expect(audit.ip).toBe('9.9.9.9');
  });

  it('refuses non-owners, read-only gyms and suspended gyms', async () => {
    const { db, service, user, gymId } = await ownedGym();
    const member = db.seed.user();
    db.seed.member({ gymId, userId: member.id, role: 'MEMBER' });
    expect(await failure(service.update(member.id, gymId, { name: 'Hacked Name' } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });

    db.state.subs[0]!.status = 'READ_ONLY';
    expect(await failure(service.update(user.id, gymId, { name: 'Late Edit' } as never, undefined))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    await expect(service.getForUser(user.id, gymId)).resolves.toBeDefined(); // reading still works

    db.state.subs[0]!.status = 'TRIAL';
    db.state.gyms[0]!.status = 'SUSPENDED';
    expect(await failure(service.update(user.id, gymId, { name: 'Late Edit' } as never, undefined))).toEqual({ status: 403, code: 'GYM_SUSPENDED' });
  });
});

describe('GymsService.preview', () => {
  it('shows a minimal preview with the member count and your own relationship', async () => {
    const { db, service, user } = setup();
    const detail = await service.create(user.id, body(), undefined);
    const code = detail.code!;
    db.seed.member({ gymId: detail.id, userId: db.seed.user().id, role: 'MEMBER' });
    db.seed.member({ gymId: detail.id, userId: db.seed.user().id, role: 'MEMBER', status: 'PENDING' });
    const viewer = db.seed.user();
    db.seed.member({ gymId: detail.id, userId: viewer.id, role: 'MEMBER', status: 'PENDING' });

    const preview = await service.preview(viewer.id, code);
    expect(preview).toMatchObject({ name: "Gold's Gym", city: 'Jabalpur', memberCount: 1, myRoles: [], myRequest: { status: 'PENDING' } });
    for (const key of ['id', 'latitude', 'longitude', 'code']) expect(key in preview).toBe(false);

    const ownerView = await service.preview(user.id, code);
    expect(ownerView.myRoles).toEqual(['OWNER']);
    expect(ownerView.myRequest).toBeNull();
  });

  it('answers 404 for an unknown code or a suspended gym', async () => {
    const { db, service, user } = setup();
    const detail = await service.create(user.id, body(), undefined);
    expect(await failure(service.preview(user.id, 'ZZZZZZ'))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    db.state.gyms[0]!.status = 'SUSPENDED';
    expect(await failure(service.preview(user.id, detail.code!))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });
});