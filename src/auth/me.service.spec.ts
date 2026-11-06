import { describe, expect, it, vi } from 'vitest';
import { MeService } from './me.service.js';

const row = {
  id: 'user-1',
  phone: '+919999900001',
  username: 'rajit',
  name: 'Rajit',
  avatarUrl: null,
  bio: null,
  privacy: 'PUBLIC',
  profileCompletedAt: new Date('2026-11-01T00:00:00.000Z') as Date | null,
  createdAt: new Date('2026-10-30T00:00:00.000Z'),
  gymMemberships: [
    { gymId: 'gym-1', role: 'MEMBER', status: 'ACTIVE', gym: { name: "Gold's Gym" } },
    { gymId: 'gym-2', role: 'OWNER', status: 'ACTIVE', gym: { name: 'CALFIT Test Gym' } },
  ],
};

function setup(result: typeof row | null) {
  const findUnique = vi.fn(async (_args: unknown) => result);
  const service = new MeService({ user: { findUnique } } as never);
  return { service, findUnique };
}

describe('MeService.getMe', () => {
  it('maps the user and their gym memberships', async () => {
    const { service } = setup(row);
    const me = await service.getMe('user-1');
    expect(me.id).toBe('user-1');
    expect(me.username).toBe('rajit');
    expect(me.profileCompleted).toBe(true);
    expect(me.createdAt).toBe('2026-10-30T00:00:00.000Z');
    expect(me.gyms).toEqual([
      { gymId: 'gym-1', gymName: "Gold's Gym", role: 'MEMBER', status: 'ACTIVE' },
      { gymId: 'gym-2', gymName: 'CALFIT Test Gym', role: 'OWNER', status: 'ACTIVE' },
    ]);
  });

  it('reports profileCompleted=false when profile setup has not finished', async () => {
    const { service } = setup({ ...row, profileCompletedAt: null });
    expect((await service.getMe('user-1')).profileCompleted).toBe(false);
  });

  it('returns only the public-safe field set', async () => {
    const { service } = setup(row);
    const me = await service.getMe('user-1');
    expect(Object.keys(me).sort()).toEqual(
      [
        'avatarUrl',
        'bio',
        'createdAt',
        'gyms',
        'id',
        'name',
        'phone',
        'privacy',
        'profileCompleted',
        'username',
      ].sort(),
    );
  });

  it('looks the user up by id', async () => {
    const { service, findUnique } = setup(row);
    await service.getMe('user-1');
    const args = findUnique.mock.calls[0]?.[0] as { where: { id: string } };
    expect(args.where).toEqual({ id: 'user-1' });
  });

  it('asks only for invited, pending and active memberships', async () => {
    const { service, findUnique } = setup(row);
    await service.getMe('user-1');
    const args = findUnique.mock.calls[0]?.[0] as {
      select: { gymMemberships: { where: { status: { in: string[] } } } };
    };
    expect(args.select.gymMemberships.where.status.in).toEqual(['INVITED', 'PENDING', 'ACTIVE']);
  });

  it('answers 401 SESSION_INVALID when the user no longer exists', async () => {
    const { service } = setup(null);
    const error = await service.getMe('user-1').catch((e: unknown) => e);
    const body = (error as { getResponse: () => { code?: string } }).getResponse();
    expect(body.code).toBe('SESSION_INVALID');
  });
});