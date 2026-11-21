import { describe, expect, it } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeGymDb } from '../../test/support/fake-gym-db.js';
import { GymAccessService, primaryRole } from './gym-access.service.js';
import type { GymAccess } from './gym-access.service.js';

function setup(subscriptionStatus: string | null = 'TRIAL', gymStatus = 'ACTIVE') {
  const db = makeGymDb();
  const user = db.seed.user();
  const gym = db.seed.gym({ status: gymStatus });
  if (subscriptionStatus) db.seed.sub({ gymId: gym.id, status: subscriptionStatus });
  const service = new GymAccessService(db.prisma as never);
  return { db, user, gym, service };
}

const access = (over: Partial<GymAccess> = {}): GymAccess => ({
  gymId: 'g',
  roles: ['OWNER'],
  gymStatus: 'ACTIVE',
  subscriptionStatus: 'TRIAL',
  ...over,
});

function errorCode(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { getResponse: () => { code: string } }).getResponse().code;
  }
  return undefined;
}

describe('GymAccessService', () => {
  it('returns every ACTIVE role, plus the gym and subscription status', async () => {
    const { db, user, gym, service } = setup();
    db.seed.member({ gymId: gym.id, userId: user.id, role: 'OWNER' });
    db.seed.member({ gymId: gym.id, userId: user.id, role: 'MEMBER' });
    const result = await service.requireMember(user.id, gym.id);
    expect([...result.roles].sort()).toEqual(['MEMBER', 'OWNER']);
    expect(result).toMatchObject({ gymId: gym.id, gymStatus: 'ACTIVE', subscriptionStatus: 'TRIAL' });
  });

  it('answers 404 for strangers, pending people and malformed ids', async () => {
    const { db, user, gym, service } = setup();
    db.seed.member({ gymId: gym.id, userId: user.id, role: 'MEMBER', status: 'PENDING' });
    expect(await failure(service.requireMember(user.id, gym.id))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    expect(await failure(service.requireMember(db.seed.user().id, gym.id))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    expect(await failure(service.requireMember(user.id, 'not-a-uuid'))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });

  it('lets only owners through requireOwner', async () => {
    const { db, user, gym, service } = setup();
    db.seed.member({ gymId: gym.id, userId: user.id, role: 'TRAINER' });
    expect(await failure(service.requireOwner(user.id, gym.id))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });

    const owner = db.seed.user();
    db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
    expect((await service.requireOwner(owner.id, gym.id)).roles).toEqual(['OWNER']);
  });

  it('allows writes for TRIAL, ACTIVE, GRACE and a gym without a subscription row', () => {
    const { service } = setup();
    for (const subscriptionStatus of ['TRIAL', 'ACTIVE', 'GRACE', null]) {
      expect(() => service.assertWritable(access({ subscriptionStatus }))).not.toThrow();
    }
  });

  it('refuses writes when the subscription is READ_ONLY or the gym is suspended', () => {
    const { service } = setup();
    expect(errorCode(() => service.assertWritable(access({ subscriptionStatus: 'READ_ONLY' })))).toBe('GYM_READ_ONLY');
    expect(errorCode(() => service.assertWritable(access({ gymStatus: 'SUSPENDED' })))).toBe('GYM_SUSPENDED');
  });

  it('still lets people read a read-only or suspended gym', async () => {
    for (const [sub, status] of [['READ_ONLY', 'ACTIVE'], ['TRIAL', 'SUSPENDED']] as const) {
      const { db, user, gym, service } = setup(sub, status);
      db.seed.member({ gymId: gym.id, userId: user.id, role: 'MEMBER' });
      await expect(service.requireMember(user.id, gym.id)).resolves.toBeDefined();
    }
  });

  it('ranks roles: owner, then trainer, then member', () => {
    expect(primaryRole(['MEMBER', 'OWNER'])).toBe('OWNER');
    expect(primaryRole(['MEMBER', 'TRAINER'])).toBe('TRAINER');
    expect(primaryRole(['MEMBER'])).toBe('MEMBER');
  });
});