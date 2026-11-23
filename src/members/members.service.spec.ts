import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { FakeUniqueError, makeGymDb } from '../../test/support/fake-gym-db.js';
import type { Row } from '../../test/support/fake-gym-db.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { MembersService } from './members.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

function setup() {
  const db = makeGymDb();
  const owner = db.seed.user({ name: 'Owner One' });
  const gym = db.seed.gym({ code: 'K7M2QX', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id, status: 'TRIAL' });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER', joinedAt: NOW });
  const access = new GymAccessService(db.prisma as never);
  const service = new MembersService(db.prisma as never, access);

  let counter = 0;
  // A registered person who joined by code (no invited phone).
  const active = (name: string, over: Row = {}) => {
    const user = db.seed.user({ name, username: `u${++counter}` });
    const member = db.seed.member({
      gymId: gym.id, userId: user.id, role: 'MEMBER', status: 'ACTIVE',
      joinedAt: new Date('2026-10-01T00:00:00.000Z'), ...over,
    });
    return { user, member };
  };
  // A row the owner created in advance, not linked to an account.
  const invited = (name: string, phone: string, over: Row = {}) =>
    db.seed.member({
      gymId: gym.id, userId: null, role: 'MEMBER', status: 'INVITED', invitedName: name, invitedPhone: phone, ...over,
    });
  const query = (over: Row = {}) => ({ sort: 'name', limit: 50, ...over }) as never;
  const add = (name: string, phone: string, ip?: string) =>
    service.add(owner.id, gym.id, { name, phone } as never, ip);

  return { db, owner, gym, sub, service, access, active, invited, query, add };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MembersService.list', () => {
  it('lists ACTIVE and INVITED members only, from this gym only', async () => {
    const { db, service, owner, gym, active, invited, query } = setup();
    active('Asha Rao');
    invited('Imported Ravi', '+919000000001');
    active('Pending Pam', { status: 'PENDING' });
    active('Gone Gary', { status: 'REMOVED' });
    active('Rejected Rhea', { status: 'REJECTED' });
    const otherGym = db.seed.gym({ code: 'OTHER2' });
    db.seed.member({ gymId: otherGym.id, userId: db.seed.user().id, role: 'MEMBER', status: 'ACTIVE' });

    const result = await service.list(owner.id, gym.id, query());

    expect(result.items.map((i) => i.name)).toEqual(['Asha Rao', 'Imported Ravi']);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by status and masks the phone of pending requests', async () => {
    const { service, owner, gym, active, query } = setup();
    const { user } = active('Pending Pam', { status: 'PENDING' });
    active('Asha Rao');

    const result = await service.list(owner.id, gym.id, query({ status: 'PENDING' }));

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'PENDING', phone: null, registered: true });
    expect(result.items[0]!.phoneMasked).toMatch(/^\+91\*+\d{4}$/);
    expect(JSON.stringify(result)).not.toContain(user.phone);
  });

  it('shows full phone numbers for ACTIVE and INVITED members', async () => {
    const { service, owner, gym, active, invited, query } = setup();
    const { user } = active('Asha Rao');
    invited('Ravi Kumar', '+919000000001');

    const result = await service.list(owner.id, gym.id, query());

    expect(result.items.map((i) => i.phone)).toEqual([user.phone, '+919000000001']);
  });

  it('searches name, username and visible phone numbers', async () => {
    const { service, owner, gym, active, invited, query } = setup();
    active('Asha Rao');
    active('Bina Shah');
    invited('Ravi Kumar', '+919123456780');
    const names = async (q: string) => (await service.list(owner.id, gym.id, query({ q }))).items.map((i) => i.name);

    expect(await names('ASHA')).toEqual(['Asha Rao']);
    expect(await names('u2')).toEqual(['Bina Shah']);
    expect(await names('9123456')).toEqual(['Ravi Kumar']);
    expect(await names('12')).toEqual([]);
  });

  it('cannot be used to find a hidden phone number', async () => {
    const { service, owner, gym, active, query } = setup();
    const { user } = active('Pending Pam', { status: 'PENDING' });
    const result = await service.list(owner.id, gym.id, query({ status: 'PENDING', q: user.phone }));
    expect(result.items).toEqual([]);
  });

  it('sorts and pages: name A-Z, join date newest first by default, then 2 per page', async () => {
    const { service, owner, gym, active, invited, query } = setup();
    active('Cara', { joinedAt: new Date('2026-10-03T00:00:00.000Z') });
    active('Alan', { joinedAt: new Date('2026-10-01T00:00:00.000Z') });
    active('Bea', { joinedAt: new Date('2026-10-02T00:00:00.000Z') });
    invited('Dev', '+919000000009');
    const names = async (over: Row) => (await service.list(owner.id, gym.id, query(over))).items.map((i) => i.name);

    expect(await names({})).toEqual(['Alan', 'Bea', 'Cara', 'Dev']);
    expect(await names({ order: 'desc' })).toEqual(['Dev', 'Cara', 'Bea', 'Alan']);
    expect(await names({ sort: 'joinDate' })).toEqual(['Cara', 'Bea', 'Alan', 'Dev']);
    expect(await names({ sort: 'joinDate', order: 'asc' })).toEqual(['Alan', 'Bea', 'Cara', 'Dev']);

    const page1 = await service.list(owner.id, gym.id, query({ limit: 2 }));
    expect(page1.items.map((i) => i.name)).toEqual(['Alan', 'Bea']);
    const page2 = await service.list(owner.id, gym.id, query({ limit: 2, cursor: page1.nextCursor }));
    expect(page2.items.map((i) => i.name)).toEqual(['Cara', 'Dev']);
    expect(page2.nextCursor).toBeNull();
  });

  it('is for owners only, and still works in a read-only gym', async () => {
    const { db, service, owner, gym, sub, active, query } = setup();
    const { user } = active('Asha Rao');
    expect(await failure(service.list(user.id, gym.id, query()))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    expect(await failure(service.list(db.seed.user().id, gym.id, query()))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    sub.status = 'READ_ONLY';
    await expect(service.list(owner.id, gym.id, query())).resolves.toBeDefined();
  });
});

describe('MembersService.summary', () => {
  it('counts members by status, for this gym and the MEMBER role only', async () => {
    const { db, service, owner, gym, active, invited } = setup();
    active('A One');
    active('B Two');
    invited('C Three', '+919000000001');
    active('D Four', { status: 'PENDING' });
    active('E Five', { status: 'REMOVED' });
    active('F Six', { status: 'REJECTED' });
    const other = db.seed.gym({ code: 'OTHER2' });
    db.seed.member({ gymId: other.id, userId: db.seed.user().id, role: 'MEMBER', status: 'ACTIVE' });

    expect(await service.summary(owner.id, gym.id)).toEqual({ active: 2, invited: 1, pending: 1, removed: 1 });
  });
});

describe('MembersService.getMember', () => {
  it('returns the detail view', async () => {
    const { service, owner, gym, active } = setup();
    const { member } = active('Asha Rao', { whatsappConsent: true, whatsappConsentAt: NOW, approvedAt: NOW });
    const detail = await service.getMember(owner.id, gym.id, member.id as string);
    expect(detail).toMatchObject({
      memberId: member.id, name: 'Asha Rao', status: 'ACTIVE', registered: true, whatsappConsent: true,
      approvedAt: NOW.toISOString(), removedAt: null, whatsappConsentAt: NOW.toISOString(),
    });
  });

  it('answers 404 for unknown ids, other gyms, bad ids and the owner’s own row', async () => {
    const { db, service, owner, gym, active } = setup();
    const other = db.seed.gym({ code: 'OTHER2' });
    const stray = db.seed.member({ gymId: other.id, userId: db.seed.user().id, role: 'MEMBER' });
    const ownerRow = db.state.members.find((m) => m.role === 'OWNER')!;
    active('Asha Rao');
    const notFound = { status: 404, code: 'MEMBER_NOT_FOUND' };

    expect(await failure(service.getMember(owner.id, gym.id, '33333333-3333-4333-8333-333333333333'))).toEqual(notFound);
    expect(await failure(service.getMember(owner.id, gym.id, 'not-a-uuid'))).toEqual(notFound);
    expect(await failure(service.getMember(owner.id, gym.id, stray.id as string))).toEqual(notFound);
    expect(await failure(service.getMember(owner.id, gym.id, ownerRow.id as string))).toEqual(notFound);
  });

  it('is for owners only', async () => {
    const { service, gym, active } = setup();
    const { user, member } = active('Asha Rao');
    expect(await failure(service.getMember(user.id, gym.id, member.id as string))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
  });
});

describe('MembersService.add', () => {
  it('creates an INVITED row with the phone visible to the owner, and audits without the number', async () => {
    const { db, gym, owner, add } = setup();
    const result = await add('Imported One', '+919123450001', '1.2.3.4');

    expect(result).toMatchObject({
      status: 'INVITED', registered: false, userId: null, name: 'Imported One',
      phone: '+919123450001', whatsappConsent: false, joinedAt: null,
    });
    const row = db.state.members.find((m) => m.invitedPhone === '+919123450001')!;
    expect(row).toMatchObject({ gymId: gym.id, role: 'MEMBER', status: 'INVITED', userId: null });
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'gym_member.added', actorId: owner.id, gymId: gym.id, entityId: row.id,
      metadata: { reAdded: false }, ip: '1.2.3.4',
    });
    expect(JSON.stringify(db.state.audits)).not.toContain('+919123450001');
  });

  it('never links the row to a registered user, so the answer reveals nothing about the number', async () => {
    const { db, add } = setup();
    const person = db.seed.user({ phone: '+919123450002' });
    const result = await add('Pat Person', person.phone);
    expect(result).toMatchObject({ registered: false, userId: null, status: 'INVITED' });
    expect(db.state.members.find((m) => m.invitedPhone === person.phone)).toMatchObject({ userId: null });
  });

  it('answers MEMBER_EXISTS for people already in the list or with a pending request', async () => {
    const { service, owner, gym, active, invited } = setup();
    const { user } = active('Asha Rao');
    invited('Ravi', '+919000000001');
    const pending = active('Pending Pam', { status: 'PENDING' }).user;
    const exists = { status: 409, code: 'MEMBER_EXISTS' };
    const tryAdd = (phone: string) => failure(service.add(owner.id, gym.id, { name: 'Someone', phone } as never, undefined));

    expect(await tryAdd(user.phone)).toEqual(exists);
    expect(await tryAdd('+919000000001')).toEqual(exists);
    expect(await tryAdd(pending.phone)).toEqual(exists);
  });

  it('re-invites a removed person on the same row and clears their WhatsApp consent', async () => {
    const { db, gym, active, add } = setup();
    const { user, member } = active('Gone Gary', {
      status: 'REMOVED', removedAt: new Date('2026-10-20T00:00:00.000Z'), whatsappConsent: true, whatsappConsentAt: NOW,
    });
    db.state.consents.push({ id: 'c1', userId: user.id, gymId: gym.id, type: 'WHATSAPP', revokedAt: null });
    const before = db.state.members.length;

    const result = await add('Gary Is Back', user.phone);

    expect(db.state.members).toHaveLength(before);
    expect(member).toMatchObject({
      status: 'INVITED', userId: user.id, invitedName: 'Gary Is Back', invitedPhone: user.phone,
      removedAt: null, whatsappConsent: false, whatsappConsentAt: null,
    });
    expect(db.state.consents[0]!.revokedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ memberId: member.id, status: 'INVITED', registered: true, name: 'Gone Gary' });
    expect(db.state.audits.at(-1)!.metadata).toEqual({ reAdded: true });
  });

  it('re-invites a rejected invited row', async () => {
    const { db, invited, add } = setup();
    const row = invited('Ravi', '+919000000001', { status: 'REJECTED' });
    const before = db.state.members.length;
    expect((await add('Ravi Again', '+919000000001')).memberId).toBe(row.id);
    expect(db.state.members).toHaveLength(before);
    expect(row).toMatchObject({ status: 'INVITED', invitedName: 'Ravi Again' });
  });

  it('turns a unique-constraint race into MEMBER_EXISTS', async () => {
    const { db, add } = setup();
    vi.spyOn(db.models.gymMember, 'create').mockRejectedValueOnce(new FakeUniqueError());
    expect(await failure(add('Racer', '+919123450003'))).toEqual({ status: 409, code: 'MEMBER_EXISTS' });
  });

  it('is for owners only, and refused in read-only and suspended gyms', async () => {
    const { db, service, gym, sub, active, add } = setup();
    const { user } = active('Asha Rao');
    expect(await failure(service.add(user.id, gym.id, { name: 'Sneaky', phone: '+919123450004' } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    expect(await failure(service.add(db.seed.user().id, gym.id, { name: 'Stranger', phone: '+919123450004' } as never, undefined))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    sub.status = 'READ_ONLY';
    expect(await failure(add('Late Add', '+919123450004'))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    sub.status = 'TRIAL';
    gym.status = 'SUSPENDED';
    expect(await failure(add('Late Add', '+919123450004'))).toEqual({ status: 403, code: 'GYM_SUSPENDED' });
    expect(db.state.members.filter((m) => m.invitedPhone === '+919123450004')).toHaveLength(0);
  });
});

describe('MembersService.remove', () => {
  it('removes an active member: ends access, resets WhatsApp consent, keeps the row, and audits', async () => {
    const { db, access, service, owner, gym, active } = setup();
    const { user, member } = active('Asha Rao', { whatsappConsent: true, whatsappConsentAt: NOW });
    db.state.consents.push({ id: 'c1', userId: user.id, gymId: gym.id, type: 'WHATSAPP', revokedAt: null });

    await service.remove(owner.id, gym.id, member.id as string, '1.2.3.4');

    expect(member).toMatchObject({ status: 'REMOVED', userId: user.id, whatsappConsent: false, whatsappConsentAt: null });
    expect((member.removedAt as Date).toISOString()).toBe(NOW.toISOString());
    expect(db.state.consents[0]!.revokedAt).toBeInstanceOf(Date);
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'gym_member.removed', entityId: member.id, metadata: { previousStatus: 'ACTIVE' }, ip: '1.2.3.4',
    });
    expect(await failure(access.requireMember(user.id, gym.id))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });

  it('removes an invited member who has no account', async () => {
    const { db, service, owner, gym, invited } = setup();
    const row = invited('Ravi', '+919000000001');
    await service.remove(owner.id, gym.id, row.id as string, undefined);
    expect(row.status).toBe('REMOVED');
    expect(db.state.consents).toHaveLength(0);
  });

  it('refuses pending, removed and rejected rows', async () => {
    const { service, owner, gym, active } = setup();
    for (const status of ['PENDING', 'REMOVED', 'REJECTED']) {
      const { member } = active(`Person ${status}`, { status });
      expect(await failure(service.remove(owner.id, gym.id, member.id as string, undefined))).toEqual({
        status: 409, code: 'MEMBER_NOT_REMOVABLE',
      });
      expect(member.status).toBe(status);
    }
  });

  it('answers 404 for unknown ids, other gyms, bad ids and the OWNER row', async () => {
    const { db, service, owner, gym } = setup();
    const other = db.seed.gym({ code: 'OTHER2' });
    const stray = db.seed.member({ gymId: other.id, userId: db.seed.user().id, role: 'MEMBER' });
    const ownerRow = db.state.members.find((m) => m.role === 'OWNER')!;
    const notFound = { status: 404, code: 'MEMBER_NOT_FOUND' };

    expect(await failure(service.remove(owner.id, gym.id, '33333333-3333-4333-8333-333333333333', undefined))).toEqual(notFound);
    expect(await failure(service.remove(owner.id, gym.id, 'not-a-uuid', undefined))).toEqual(notFound);
    expect(await failure(service.remove(owner.id, gym.id, stray.id as string, undefined))).toEqual(notFound);
    expect(await failure(service.remove(owner.id, gym.id, ownerRow.id as string, undefined))).toEqual(notFound);
    expect(ownerRow.status).toBe('ACTIVE');
  });

  it('is for owners only, and refused in read-only gyms', async () => {
    const { service, owner, gym, sub, active } = setup();
    const { user, member } = active('Asha Rao');
    expect(await failure(service.remove(user.id, gym.id, member.id as string, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(service.remove(owner.id, gym.id, member.id as string, undefined))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    expect(member.status).toBe('ACTIVE');
  });

  it('refuses when another request removed the member first', async () => {
    const { db, service, owner, gym, active } = setup();
    const { member } = active('Asha Rao');
    vi.spyOn(db.models.gymMember, 'updateMany').mockResolvedValueOnce({ count: 0 });
    expect(await failure(service.remove(owner.id, gym.id, member.id as string, undefined))).toEqual({
      status: 409, code: 'MEMBER_NOT_REMOVABLE',
    });
  });
});