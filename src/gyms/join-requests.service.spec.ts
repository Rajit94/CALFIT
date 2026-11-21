import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeUniqueError, makeGymDb } from '../../test/support/fake-gym-db.js';
import { failure } from '../../test/support/failure.js';
import { GymAccessService } from './gym-access.service.js';
import { JoinRequestsService } from './join-requests.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const CODE = 'K7M2QX';
const DAY = 86_400_000;

function setup() {
  const db = makeGymDb();
  const owner = db.seed.user();
  const gym = db.seed.gym({ code: CODE, name: 'Test Gym', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id, status: 'TRIAL' });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  const me = db.seed.user({ phone: '+919876543210' });
  const service = new JoinRequestsService(db.prisma as never, new GymAccessService(db.prisma as never));
  const join = (user = me, consent = true, code = CODE) =>
    service.join(user.id, { code, whatsappConsent: consent } as never, '1.2.3.4');
  const memberRows = (userId: string) => db.state.members.filter((m) => m.userId === userId && m.role === 'MEMBER');
  return { db, owner, gym, sub, me, service, join, memberRows };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('JoinRequestsService.join', () => {
  it('creates a pending request and records WhatsApp consent', async () => {
    const { db, gym, me, join, memberRows } = setup();
    expect(await join()).toEqual({ gymId: gym.id, gymName: 'Test Gym', status: 'PENDING', autoApproved: false });

    expect(memberRows(me.id)).toEqual([
      expect.objectContaining({ status: 'PENDING', whatsappConsent: true, joinedAt: null, approvedAt: null }),
    ]);
    expect(memberRows(me.id)[0]!.whatsappConsentAt).toBeInstanceOf(Date);
    expect(db.state.consents).toEqual([expect.objectContaining({ userId: me.id, gymId: gym.id, type: 'WHATSAPP', revokedAt: null })]);
    expect(db.state.audits.at(-1)).toMatchObject({ action: 'gym_member.join_requested', actorId: me.id, gymId: gym.id });
  });

  it('records the request without consent when WhatsApp is declined', async () => {
    const { db, me, join, memberRows } = setup();
    await join(me, false);
    expect(memberRows(me.id)[0]).toMatchObject({ status: 'PENDING', whatsappConsent: false, whatsappConsentAt: null });
    expect(db.state.consents).toHaveLength(0);
  });

  it('refuses unknown, suspended and read-only gyms', async () => {
    const { gym, sub, join } = setup();
    expect(await failure(join(undefined, true, 'ZZZZZZ'))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    gym.status = 'SUSPENDED';
    expect(await failure(join())).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    gym.status = 'ACTIVE';
    sub.status = 'READ_ONLY';
    expect(await failure(join())).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
  });

  it('needs a completed profile', async () => {
    const { me, join } = setup();
    me.profileCompletedAt = null;
    expect(await failure(join())).toEqual({ status: 409, code: 'PROFILE_NOT_COMPLETED' });
  });

  it('refuses a second request while pending, and refuses current members', async () => {
    const { me, join, memberRows } = setup();
    await join();
    expect(await failure(join())).toEqual({ status: 409, code: 'JOIN_REQUEST_PENDING' });
    memberRows(me.id)[0]!.status = 'ACTIVE';
    expect(await failure(join())).toEqual({ status: 409, code: 'ALREADY_MEMBER' });
  });

  it('makes a rejected or removed person wait 7 days, then reuses the same row', async () => {
    const { gym, me, db, join, memberRows } = setup();
    const row = db.seed.member({ gymId: gym.id, userId: me.id, role: 'MEMBER', status: 'REJECTED', removedAt: new Date(NOW.getTime() - 3 * DAY) });
    expect(await failure(join())).toEqual({ status: 429, code: 'JOIN_REQUEST_TOO_SOON' });

    vi.setSystemTime(new Date(NOW.getTime() + 5 * DAY)); // 8 days after the rejection
    expect((await join()).status).toBe('PENDING');
    expect(memberRows(me.id)).toHaveLength(1);
    expect(row).toMatchObject({ status: 'PENDING', removedAt: null, whatsappConsent: true });
  });

  it('falls back to updatedAt when removedAt is empty', async () => {
    const { gym, me, db, join } = setup();
    db.seed.member({ gymId: gym.id, userId: me.id, role: 'MEMBER', status: 'REMOVED', removedAt: null, updatedAt: new Date(NOW.getTime() - 2 * DAY) });
    expect((await failure(join())).code).toBe('JOIN_REQUEST_TOO_SOON');
  });

  it('revokes the earlier WhatsApp consent when a later request declines it', async () => {
    const { gym, me, db, join, memberRows } = setup();
    db.seed.member({
      gymId: gym.id, userId: me.id, role: 'MEMBER', status: 'REJECTED', whatsappConsent: true,
      removedAt: new Date(NOW.getTime() - 10 * DAY),
    });
    db.state.consents.push({ id: 'c1', userId: me.id, gymId: gym.id, type: 'WHATSAPP', revokedAt: null });

    await join(me, false);

    expect(memberRows(me.id)[0]).toMatchObject({ whatsappConsent: false, whatsappConsentAt: null });
    expect(db.state.consents[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it('activates the row an owner imported for this phone number, keeping its join date', async () => {
    const { db, gym, me, join } = setup();
    const imported = db.seed.member({
      gymId: gym.id, userId: null, role: 'MEMBER', status: 'INVITED', invitedPhone: me.phone,
      joinedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const before = db.state.members.length;

    expect(await join()).toMatchObject({ status: 'ACTIVE', autoApproved: true });

    expect(db.state.members).toHaveLength(before); // no second row
    expect(imported).toMatchObject({ userId: me.id, status: 'ACTIVE', approvedById: null, whatsappConsent: true });
    expect(imported.joinedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(db.state.audits.at(-1)!.action).toBe('gym_member.joined');
  });

  it('ignores rows imported for other phone numbers', async () => {
    const { db, gym, me, join, memberRows } = setup();
    const other = db.seed.member({ gymId: gym.id, userId: null, role: 'MEMBER', status: 'INVITED', invitedPhone: '+919000000001' });
    expect(await join()).toMatchObject({ status: 'PENDING', autoApproved: false });
    expect(other).toMatchObject({ userId: null, status: 'INVITED' });
    expect(memberRows(me.id)).toHaveLength(1);
  });

  it('activates an owner who joins their own gym at once', async () => {
    const { db, owner, join } = setup();
    expect(await join(owner, false)).toMatchObject({ status: 'ACTIVE', autoApproved: true });
    const row = db.state.members.find((m) => m.userId === owner.id && m.role === 'MEMBER')!;
    expect(row).toMatchObject({ status: 'ACTIVE', approvedById: owner.id });
    expect(row.joinedAt).toBeInstanceOf(Date);
    expect(db.state.members.filter((m) => m.userId === owner.id)).toHaveLength(2); // OWNER + MEMBER
  });

  it('turns a unique-constraint race into a clear conflict', async () => {
    const { db, join } = setup();
    vi.spyOn(db.models.gymMember, 'create').mockRejectedValueOnce(new FakeUniqueError());
    expect(await failure(join())).toEqual({ status: 409, code: 'JOIN_REQUEST_PENDING' });
  });
});

describe('JoinRequestsService.list', () => {
  function withPending(count: number) {
    const env = setup();
    const users = Array.from({ length: count }, (_, i) => {
      const user = env.db.seed.user({ phone: `+91900000${String(1000 + i)}`, name: `Person ${i}` });
      env.db.seed.member({ gymId: env.gym.id, userId: user.id, role: 'MEMBER', status: 'PENDING' });
      return user;
    });
    return { ...env, users };
  }

  it('lists oldest first with masked phone numbers, and paginates', async () => {
    const { service, owner, gym, users } = withPending(3);
    const first = await service.list(owner.id, gym.id, { limit: 2 });
    expect(first.items.map((i) => i.user.name)).toEqual(['Person 0', 'Person 1']);
    expect(first.nextCursor).not.toBeNull();
    expect(first.items[0]!.user.phoneMasked).toBe('+91******1000');
    expect(JSON.stringify(first)).not.toContain(users[0]!.phone);

    const second = await service.list(owner.id, gym.id, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.user.name)).toEqual(['Person 2']);
    expect(second.nextCursor).toBeNull();
  });

  it('is only for owners', async () => {
    const { service, db, gym, me } = withPending(1);
    db.seed.member({ gymId: gym.id, userId: me.id, role: 'MEMBER' });
    expect(await failure(service.list(me.id, gym.id, { limit: 10 }))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    expect(await failure(service.list(db.seed.user().id, gym.id, { limit: 10 }))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });
});

describe('JoinRequestsService.decide', () => {
  async function pending() {
    const env = setup();
    await env.join();
    return { ...env, memberId: env.memberRows(env.me.id)[0]!.id as string };
  }

  it('approves a request: activates it, sets the join date and the approver, and audits', async () => {
    const { service, db, owner, gym, memberId } = await pending();
    expect(await service.decide(owner.id, gym.id, memberId, 'approve', '5.5.5.5')).toEqual({ memberId, status: 'ACTIVE' });
    const row = db.state.members.find((m) => m.id === memberId)!;
    expect(row).toMatchObject({ status: 'ACTIVE', approvedById: owner.id });
    expect(row.joinedAt).toBeInstanceOf(Date);
    expect(db.state.audits.at(-1)).toMatchObject({ action: 'gym_member.approved', entityId: memberId, ip: '5.5.5.5' });
  });

  it('rejects a request and records when', async () => {
    const { service, db, owner, gym, memberId } = await pending();
    expect(await service.decide(owner.id, gym.id, memberId, 'reject', undefined)).toEqual({ memberId, status: 'REJECTED' });
    const row = db.state.members.find((m) => m.id === memberId)!;
    expect(row.status).toBe('REJECTED');
    expect(row.removedAt).toBeInstanceOf(Date);
    expect(db.state.audits.at(-1)!.action).toBe('gym_member.rejected');
  });

  it('answers 404 for a decided request, a bad id, or another gym’s request', async () => {
    const { service, db, owner, gym, memberId } = await pending();
    await service.decide(owner.id, gym.id, memberId, 'approve', undefined);
    expect(await failure(service.decide(owner.id, gym.id, memberId, 'approve', undefined))).toEqual({ status: 404, code: 'JOIN_REQUEST_NOT_FOUND' });
    expect(await failure(service.decide(owner.id, gym.id, 'not-a-uuid', 'approve', undefined))).toEqual({ status: 404, code: 'JOIN_REQUEST_NOT_FOUND' });

    const otherGym = db.seed.gym({ code: 'OTHER2' });
    db.seed.sub({ gymId: otherGym.id });
    db.seed.member({ gymId: otherGym.id, userId: owner.id, role: 'OWNER' });
    const stray = db.seed.member({ gymId: gym.id, userId: db.seed.user().id, role: 'MEMBER', status: 'PENDING' });
    expect(await failure(service.decide(owner.id, otherGym.id, stray.id as string, 'approve', undefined))).toEqual({ status: 404, code: 'JOIN_REQUEST_NOT_FOUND' });
  });

  it('refuses members, and refuses decisions in a read-only gym', async () => {
    const { service, db, owner, gym, sub, memberId } = await pending();
    const member = db.seed.user();
    db.seed.member({ gymId: gym.id, userId: member.id, role: 'MEMBER' });
    expect(await failure(service.decide(member.id, gym.id, memberId, 'approve', undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(service.decide(owner.id, gym.id, memberId, 'approve', undefined))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
  });
});