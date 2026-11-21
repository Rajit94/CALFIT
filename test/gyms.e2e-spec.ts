import { randomBytes, randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays } from '../src/common/date-only.js';
import { istDateString } from '../src/common/profile/age.js';
import { addCalendarMonths } from '../src/gyms/trial.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ALLOWED_TEST_DATABASES } from './support/e2e-env.js';

// The database guard already ran (see test/support/e2e-setup.ts) before this file was loaded.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: INestApplication;
let prisma: PrismaService;
let baseUrl = '';

const tag = randomBytes(3).toString('hex');
const phones: string[] = [];
const uname = (label: string) => `e2e${tag}${label}`;
const CODE_FORMAT = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const DAY = 86_400_000;

beforeAll(async () => {
  const { AppModule } = await import('../src/app.module.js');
  const { PrismaService: PrismaServiceClass } = await import('../src/prisma/prisma.service.js');
  const { createRequestLogger } = await import('../src/common/logging/request-logger.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(createRequestLogger({ log: () => undefined, warn: () => undefined, error: () => undefined }));
  await app.init();
  prisma = app.get(PrismaServiceClass);

  const rows = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
  const connected = rows[0]?.db ?? '(unknown)';
  if (!ALLOWED_TEST_DATABASES.includes(connected)) {
    await app.close();
    throw new Error(`Refusing to run: connected to "${connected}", which is not a test database.`);
  }
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  try {
    if (prisma) {
      const users = await prisma.user.findMany({ where: { phone: { in: phones } }, select: { id: true } });
      const ids = users.map((u) => u.id);
      await prisma.gym.deleteMany({ where: { createdById: { in: ids } } }); // memberships, subscription, holidays cascade
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  } finally {
    await app?.close();
  }
});

function newPhone(): string {
  const phone = `+919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  phones.push(phone);
  return phone;
}

async function api(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function signIn(phone = newPhone()): Promise<{ phone: string; token: string }> {
  expect((await api('POST', '/auth/otp/request', { body: { phone } })).status).toBe(200);
  const res = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
  expect(res.status).toBe(200);
  return { phone, token: res.json.accessToken as string };
}

function dobFor(ageYears: number): string {
  const d = new Date(`${istDateString()}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - ageYears);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

interface Person {
  phone: string;
  token: string;
  id: string;
}

// An adult with a completed profile.
async function adult(label: string): Promise<Person> {
  const { phone, token } = await signIn();
  const res = await api('PUT', '/users/me/profile', {
    token,
    body: { name: `User ${label}`, username: uname(label), dateOfBirth: dobFor(30) },
  });
  expect(res.status).toBe(200);
  const id = (await prisma.user.findUniqueOrThrow({ where: { phone } })).id;
  return { phone, token, id };
}

const gymBody = (over: Json = {}) => ({
  name: `E2E Gym ${tag}`,
  city: 'Jabalpur',
  latitude: 23.1815,
  longitude: 79.9864,
  ...over,
});

async function createGym(token: string, over: Json = {}): Promise<Json> {
  const res = await api('POST', '/gyms', { token, body: gymBody(over) });
  expect(res.status).toBe(201);
  return res.json;
}

const me = (token: string) => api('GET', '/auth/me', { token });
const join = (p: Person, code: string, consent = true) =>
  api('POST', '/gyms/join', { token: p.token, body: { code, whatsappConsent: consent } });
const memberRow = (gymId: string, userId: string) =>
  prisma.gymMember.findFirstOrThrow({ where: { gymId, userId, role: 'MEMBER' } });
const decide = (owner: Person, gymId: string, memberId: string, what: 'approve' | 'reject') =>
  api('POST', `/gyms/${gymId}/join-requests/${memberId}/${what}`, { token: owner.token });
const codes = (res: { json: Json }) => [res.json.code, res.json.details?.map((d: Json) => d.field)];

describe('every gym route needs a token', () => {
  it('answers 401 TOKEN_MISSING without one', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const routes: Array<[string, string]> = [
      ['POST', '/gyms'], ['GET', '/gyms/preview?code=ABCDEF'], ['POST', '/gyms/join'], ['GET', `/gyms/${id}`],
      ['PATCH', `/gyms/${id}`], ['GET', `/gyms/${id}/join-requests`], ['POST', `/gyms/${id}/join-requests/${id}/approve`],
      ['POST', `/gyms/${id}/join-requests/${id}/reject`], ['GET', `/gyms/${id}/holidays`], ['POST', `/gyms/${id}/holidays`],
      ['DELETE', `/gyms/${id}/holidays/${id}`],
    ];
    for (const [method, path] of routes) {
      const res = await api(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect([method, path, res.status, res.json.code]).toEqual([method, path, 401, 'TOKEN_MISSING']);
    }
  });
});

describe('creating a gym', () => {
  it('needs a completed profile and an adult owner', async () => {
    const fresh = await signIn();
    const early = await api('POST', '/gyms', { token: fresh.token, body: gymBody() });
    expect([early.status, early.json.code]).toEqual([409, 'PROFILE_NOT_COMPLETED']);

    const minor = await signIn();
    await api('PUT', '/users/me/profile', {
      token: minor.token,
      body: { name: 'Young Person', username: uname('minor'), dateOfBirth: dobFor(15) },
    });
    await prisma.user.update({ where: { phone: minor.phone }, data: { profileCompletedAt: new Date() } });
    const refused = await api('POST', '/gyms', { token: minor.token, body: gymBody() });
    expect([refused.status, refused.json.code]).toEqual([403, 'GYM_OWNER_MUST_BE_ADULT']);
  });

  it('validates the input', async () => {
    const owner = await adult('v');
    const bad: Json[] = [
      { latitude: 91 }, { longitude: 181 }, { latitude: 0, longitude: 0 }, { checkInRadiusM: 10 },
      { name: 'A' }, { pincode: '12' }, { timings: { mon: [['10:00', '06:00']] } },
    ];
    for (const over of bad) {
      const res = await api('POST', '/gyms', { token: owner.token, body: gymBody(over) });
      expect([JSON.stringify(over), res.status, res.json.code]).toEqual([JSON.stringify(over), 400, 'VALIDATION_FAILED']);
    }
    const { city: _city, ...noCity } = gymBody();
    expect(codes(await api('POST', '/gyms', { token: owner.token, body: noCity }))).toEqual(['VALIDATION_FAILED', ['city']]);
  });

  it('creates the gym, the owner membership, a two-month trial and default settings', async () => {
    const owner = await adult('c');
    const gym = await createGym(owner.token, { description: 'The best gym', checkInRadiusM: 200 });

    expect(gym).toMatchObject({
      name: `E2E Gym ${tag}`, city: 'Jabalpur', checkInRadiusM: 200, myRole: 'OWNER', status: 'ACTIVE',
      isVerified: false, pendingJoinRequests: 0, timezone: 'Asia/Kolkata',
    });
    expect(gym.code).toMatch(CODE_FORMAT);
    expect(gym.subscription).toMatchObject({ status: 'TRIAL', pricePerMonth: 499, monthlyMessageLimit: 1000 });
    expect(gym.subscription.trialDaysLeft).toBeGreaterThanOrEqual(58);
    expect(gym.subscription.trialDaysLeft).toBeLessThanOrEqual(62);
    expect(JSON.stringify(gym)).not.toContain('qrSecret');

    const row = await prisma.gym.findUniqueOrThrow({
      where: { id: gym.id },
      include: { members: true, subscription: true, reminderSettings: true },
    });
    expect(row.qrSecret.length).toBeGreaterThanOrEqual(40);
    expect(row.members).toHaveLength(1);
    expect(row.members[0]).toMatchObject({ userId: owner.id, role: 'OWNER', status: 'ACTIVE' });
    expect(row.subscription?.status).toBe('TRIAL');
    expect(row.subscription?.trialEndsAt.getTime()).toBe(addCalendarMonths(row.subscription!.trialStartsAt, 2).getTime());
    expect(Number(row.subscription?.pricePerMonth)).toBe(499);
    expect(row.subscription?.monthlyMessageLimit).toBe(1000);
    expect(row.reminderSettings).toMatchObject({ remindBeforeDays: 3, remindOnDueDate: true, remindWhenOverdue: true });
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'gym.created' } })).toBe(1);

    const profile = await me(owner.token);
    expect(profile.json.gyms).toEqual([{ gymId: gym.id, gymName: gym.name, role: 'OWNER', status: 'ACTIVE' }]);
  });

  it('limits a person to three gyms', async () => {
    const owner = await adult('lim');
    for (let i = 0; i < 3; i++) await createGym(owner.token, { name: `Limit Gym ${i}` });
    const fourth = await api('POST', '/gyms', { token: owner.token, body: gymBody() });
    expect([fourth.status, fourth.json.code]).toEqual([403, 'GYM_LIMIT_REACHED']);
  });
});

describe('gym details and editing', () => {
  let owner: Person;
  let member: Person;
  let gym: Json;

  beforeAll(async () => {
    owner = await adult('eo');
    member = await adult('em');
    gym = await createGym(owner.token);
    await join(member, gym.code);
    await decide(owner, gym.id, (await memberRow(gym.id, member.id)).id, 'approve');
  });

  it('answers 404 to strangers and for malformed ids', async () => {
    const stranger = await adult('es');
    const hidden = await api('GET', `/gyms/${gym.id}`, { token: stranger.token });
    expect([hidden.status, hidden.json.code]).toEqual([404, 'GYM_NOT_FOUND']);
    expect((await api('GET', '/gyms/not-a-uuid', { token: owner.token })).json.code).toBe('GYM_NOT_FOUND');
  });

  it('shows the owner the code and subscription, and members only the public details', async () => {
    const asOwner = await api('GET', `/gyms/${gym.id}`, { token: owner.token });
    expect(asOwner.json).toMatchObject({ code: gym.code, myRole: 'OWNER' });
    expect(asOwner.json.subscription.status).toBe('TRIAL');

    const asMember = await api('GET', `/gyms/${gym.id}`, { token: member.token });
    expect(asMember.status).toBe(200);
    expect(asMember.json.myRole).toBe('MEMBER');
    for (const key of ['code', 'subscription', 'pendingJoinRequests']) expect(key in asMember.json).toBe(false);
  });

  it('lets the owner edit the gym and records which fields changed', async () => {
    const res = await api('PATCH', `/gyms/${gym.id}`, {
      token: owner.token,
      body: { name: 'Renamed Gym', description: 'About us', checkInRadiusM: 250, timings: { mon: [['06:00', '10:00']] } },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: 'Renamed Gym', description: 'About us', checkInRadiusM: 250, timings: { mon: [['06:00', '10:00']] } });
    expect((await api('PATCH', `/gyms/${gym.id}`, { token: owner.token, body: { description: '' } })).json.description).toBeNull();

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { gymId: gym.id, action: 'gym.updated' }, orderBy: { createdAt: 'asc' } });
    expect((audit.metadata as Json).fields).toEqual(['name', 'description', 'checkInRadiusM', 'timings']);
  });

  it('rejects bad edits and fields that cannot be changed', async () => {
    const send = (body: unknown) => api('PATCH', `/gyms/${gym.id}`, { token: owner.token, body });
    expect((await send({})).json.code).toBe('VALIDATION_FAILED');
    expect((await send({ latitude: 10 })).json.code).toBe('VALIDATION_FAILED');
    expect((await send({ code: 'ABCDEF' })).json.code).toBe('VALIDATION_FAILED');
    expect((await send({ status: 'SUSPENDED' })).json.code).toBe('VALIDATION_FAILED');
    expect((await send({ checkInRadiusM: 10 })).json.code).toBe('VALIDATION_FAILED');
    expect((await api('GET', `/gyms/${gym.id}`, { token: owner.token })).json.code).toBe(gym.code);
  });

  it('refuses edits from members', async () => {
    const res = await api('PATCH', `/gyms/${gym.id}`, { token: member.token, body: { name: 'Hijacked' } });
    expect([res.status, res.json.code]).toEqual([403, 'GYM_FORBIDDEN']);
  });
});

describe('joining a gym', () => {
  let owner: Person;
  let gym: Json;

  beforeAll(async () => {
    owner = await adult('jo');
    gym = await createGym(owner.token);
  });

  it('previews a gym by code, in any case and with a hyphen', async () => {
    const viewer = await adult('pv');
    const res = await api('GET', `/gyms/preview?code=${gym.code}`, { token: viewer.token });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: gym.name, city: 'Jabalpur', memberCount: 0, myRoles: [], myRequest: null });
    for (const key of ['id', 'latitude', 'longitude', 'code']) expect(key in res.json).toBe(false);

    const typed = `${String(gym.code).slice(0, 3).toLowerCase()}-${String(gym.code).slice(3).toLowerCase()}`;
    expect((await api('GET', `/gyms/preview?code=${encodeURIComponent(typed)}`, { token: viewer.token })).status).toBe(200);
    expect((await api('GET', '/gyms/preview?code=ZZZZZZ', { token: viewer.token })).json.code).toBe('GYM_NOT_FOUND');
    expect(codes(await api('GET', '/gyms/preview?code=abc', { token: viewer.token }))).toEqual(['VALIDATION_FAILED', ['code']]);
    expect((await api('GET', '/gyms/preview', { token: viewer.token })).json.code).toBe('VALIDATION_FAILED');
  });

  it('needs a completed profile, and an explicit consent answer', async () => {
    const fresh = await signIn();
    const early = await api('POST', '/gyms/join', { token: fresh.token, body: { code: gym.code, whatsappConsent: true } });
    expect([early.status, early.json.code]).toEqual([409, 'PROFILE_NOT_COMPLETED']);

    const person = await adult('jc');
    const missing = await api('POST', '/gyms/join', { token: person.token, body: { code: gym.code } });
    expect(codes(missing)).toEqual(['VALIDATION_FAILED', ['whatsappConsent']]);
    expect((await join(person, 'ZZZZZZ')).json.code).toBe('GYM_NOT_FOUND');
  });

  it('creates a pending request that the owner sees, approves, and the member can then use', async () => {
    const r1 = await adult('r1');
    const requested = await join(r1, gym.code);
    expect(requested.status).toBe(200);
    expect(requested.json).toEqual({ gymId: gym.id, gymName: gym.name, status: 'PENDING', autoApproved: false });

    const row = await memberRow(gym.id, r1.id);
    expect(row).toMatchObject({ status: 'PENDING', whatsappConsent: true });
    const consents = await prisma.consentRecord.findMany({ where: { userId: r1.id, type: 'WHATSAPP', gymId: gym.id } });
    expect(consents).toHaveLength(1);
    expect(consents[0]?.revokedAt).toBeNull();

    expect((await me(r1.token)).json.gyms).toEqual([{ gymId: gym.id, gymName: gym.name, role: 'MEMBER', status: 'PENDING' }]);
    expect((await api('GET', `/gyms/${gym.id}`, { token: r1.token })).json.code).toBe('GYM_NOT_FOUND');
    expect((await join(r1, gym.code)).json.code).toBe('JOIN_REQUEST_PENDING');
    expect((await api('GET', `/gyms/${gym.id}`, { token: owner.token })).json.pendingJoinRequests).toBeGreaterThanOrEqual(1);

    const list = await api('GET', `/gyms/${gym.id}/join-requests`, { token: owner.token });
    expect(list.status).toBe(200);
    const item = (list.json.items as Json[]).find((i) => i.memberId === row.id)!;
    expect(item.user.id).toBe(r1.id);
    expect(item.user.phoneMasked).toMatch(/^\+91\*+\d{4}$/);
    expect(list.text).not.toContain(r1.phone);
    expect((await api('GET', `/gyms/${gym.id}/join-requests`, { token: r1.token })).json.code).toBe('GYM_NOT_FOUND');

    const approved = await decide(owner, gym.id, row.id, 'approve');
    expect([approved.status, approved.json]).toEqual([200, { memberId: row.id, status: 'ACTIVE' }]);
    const approvedRow = await memberRow(gym.id, r1.id);
    expect(approvedRow).toMatchObject({ status: 'ACTIVE', approvedById: owner.id });
    expect(approvedRow.joinedAt).not.toBeNull();

    const detail = await api('GET', `/gyms/${gym.id}`, { token: r1.token });
    expect([detail.status, detail.json.myRole, 'code' in detail.json]).toEqual([200, 'MEMBER', false]);
    const preview = await api('GET', `/gyms/preview?code=${gym.code}`, { token: r1.token });
    expect(preview.json.memberCount).toBeGreaterThanOrEqual(1);
    expect(preview.json.myRequest).toEqual({ status: 'ACTIVE' });

    expect((await join(r1, gym.code)).json.code).toBe('ALREADY_MEMBER');
    expect((await decide(owner, gym.id, row.id, 'approve')).json.code).toBe('JOIN_REQUEST_NOT_FOUND');
    const asMember = await api('GET', `/gyms/${gym.id}/join-requests`, { token: r1.token });
    expect([asMember.status, asMember.json.code]).toEqual([403, 'GYM_FORBIDDEN']);
    expect((await decide(r1, gym.id, row.id, 'approve')).json.code).toBe('GYM_FORBIDDEN');
  });

  it('records no consent when declined, and handles a rejection and the 7-day wait', async () => {
    const r2 = await adult('r2');
    await join(r2, gym.code, false);
    const row = await memberRow(gym.id, r2.id);
    expect(row.whatsappConsent).toBe(false);
    expect(await prisma.consentRecord.count({ where: { userId: r2.id, type: 'WHATSAPP' } })).toBe(0);

    const rejected = await decide(owner, gym.id, row.id, 'reject');
    expect([rejected.status, rejected.json]).toEqual([200, { memberId: row.id, status: 'REJECTED' }]);
    expect((await memberRow(gym.id, r2.id)).removedAt).not.toBeNull();

    const tooSoon = await join(r2, gym.code);
    expect([tooSoon.status, tooSoon.json.code]).toEqual([429, 'JOIN_REQUEST_TOO_SOON']);

    await prisma.gymMember.update({ where: { id: row.id }, data: { removedAt: new Date(Date.now() - 8 * DAY) } });
    const again = await join(r2, gym.code);
    expect([again.status, again.json.status]).toEqual([200, 'PENDING']);
    expect((await memberRow(gym.id, r2.id)).id).toBe(row.id); // the same row is reused
    expect((await decide(owner, gym.id, row.id, 'approve')).status).toBe(200);
  });

  it('answers 404 for unknown request ids', async () => {
    const unknown = await decide(owner, gym.id, '22222222-2222-4222-8222-222222222222', 'approve');
    expect([unknown.status, unknown.json.code]).toEqual([404, 'JOIN_REQUEST_NOT_FOUND']);
    expect((await decide(owner, gym.id, 'not-a-uuid', 'reject')).json.code).toBe('JOIN_REQUEST_NOT_FOUND');
  });

  it('activates the owner who joins their own gym at once, keeping the OWNER role', async () => {
    const res = await join(owner, gym.code, false);
    expect(res.json).toMatchObject({ status: 'ACTIVE', autoApproved: true });
    const detail = await api('GET', `/gyms/${gym.id}`, { token: owner.token });
    expect([...detail.json.myRoles].sort()).toEqual(['MEMBER', 'OWNER']);
    expect(detail.json.myRole).toBe('OWNER');
    const entries = ((await me(owner.token)).json.gyms as Json[]).filter((g) => g.gymId === gym.id);
    expect(entries.map((g) => g.role).sort()).toEqual(['MEMBER', 'OWNER']);
  });

  it('activates the row an owner imported for this phone number, instead of creating a new one', async () => {
    const person = await adult('imp');
    const imported = await prisma.gymMember.create({
      data: { gymId: gym.id, role: 'MEMBER', status: 'INVITED', invitedPhone: person.phone, invitedName: 'Imported Person' },
    });
    const res = await join(person, gym.code);
    expect(res.json).toMatchObject({ status: 'ACTIVE', autoApproved: true });
    const row = await memberRow(gym.id, person.id);
    expect(row.id).toBe(imported.id);
    expect(row).toMatchObject({ status: 'ACTIVE', invitedPhone: person.phone });
    expect(await prisma.gymMember.count({ where: { gymId: gym.id, role: 'MEMBER', invitedPhone: person.phone } })).toBe(1);
  });
});

describe('read-only and suspended gyms', () => {
  it('blocks writes and new requests in a read-only gym, but not reading', async () => {
    const owner = await adult('ro');
    const gym = await createGym(owner.token);
    const person = await adult('rop');
    const pending = await adult('ropp');
    await join(pending, gym.code);
    const pendingRow = await memberRow(gym.id, pending.id);

    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'READ_ONLY' } });

    expect((await join(person, gym.code)).json.code).toBe('GYM_READ_ONLY');
    expect((await api('PATCH', `/gyms/${gym.id}`, { token: owner.token, body: { name: 'Too Late' } })).json.code).toBe('GYM_READ_ONLY');
    expect((await decide(owner, gym.id, pendingRow.id, 'approve')).json.code).toBe('GYM_READ_ONLY');
    const holiday = await api('POST', `/gyms/${gym.id}/holidays`, { token: owner.token, body: { date: istDateString() } });
    expect(holiday.json.code).toBe('GYM_READ_ONLY');

    const read = await api('GET', `/gyms/${gym.id}`, { token: owner.token });
    expect([read.status, read.json.subscription.status]).toEqual([200, 'READ_ONLY']);

    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'TRIAL' } });
    expect((await join(person, gym.code)).status).toBe(200);
  });

  it('hides a suspended gym from preview and join, and blocks its owner’s writes', async () => {
    const owner = await adult('su');
    const gym = await createGym(owner.token);
    const person = await adult('sup');
    await prisma.gym.update({ where: { id: gym.id }, data: { status: 'SUSPENDED' } });

    expect((await api('GET', `/gyms/preview?code=${gym.code}`, { token: person.token })).json.code).toBe('GYM_NOT_FOUND');
    expect((await join(person, gym.code)).json.code).toBe('GYM_NOT_FOUND');
    expect((await api('PATCH', `/gyms/${gym.id}`, { token: owner.token, body: { name: 'Nope Nope' } })).json.code).toBe('GYM_SUSPENDED');
    expect((await api('GET', `/gyms/${gym.id}`, { token: owner.token })).status).toBe(200);
  });
});

describe('holidays', () => {
  let owner: Person;
  let member: Person;
  let gym: Json;
  const today = istDateString();
  const tomorrow = addDays(today, 1);
  const holidays = (token: string, query = '') => api('GET', `/gyms/${gym.id}/holidays${query}`, { token });
  const add = (token: string, body: unknown) => api('POST', `/gyms/${gym.id}/holidays`, { token, body });

  beforeAll(async () => {
    owner = await adult('ho');
    member = await adult('hm');
    gym = await createGym(owner.token);
    await join(member, gym.code);
    await decide(owner, gym.id, (await memberRow(gym.id, member.id)).id, 'approve');
  });

  it('lets the owner declare holidays, and members read them in date order', async () => {
    const later = await add(owner.token, { date: addDays(today, 30), reason: 'Festival' });
    expect(later.status).toBe(201);
    expect(later.json).toMatchObject({ date: addDays(today, 30), reason: 'Festival' });
    expect((await add(owner.token, { date: tomorrow })).status).toBe(201);
    expect((await add(owner.token, { date: today })).status).toBe(201);

    const list = await holidays(member.token);
    expect(list.status).toBe(200);
    expect((list.json.items as Json[]).map((i) => i.date)).toEqual([today, tomorrow, addDays(today, 30)]);
    expect(((await holidays(member.token, `?from=${tomorrow}&to=${tomorrow}`)).json.items as Json[])).toHaveLength(1);
    expect((await holidays(member.token, `?from=${addDays(today, 5)}&to=${today}`)).json.code).toBe('VALIDATION_FAILED');
    expect((await holidays(member.token, '?from=soon')).json.code).toBe('VALIDATION_FAILED');
  });

  it('refuses the past, dates too far ahead, duplicates and non-owners', async () => {
    const past = await add(owner.token, { date: addDays(today, -1) });
    expect([past.status, past.json.code]).toEqual([400, 'HOLIDAY_DATE_INVALID']);
    expect((await add(owner.token, { date: addDays(today, 366) })).json.code).toBe('HOLIDAY_DATE_INVALID');
    expect((await add(owner.token, { date: '2026-02-30' })).json.code).toBe('VALIDATION_FAILED');
    const duplicate = await add(owner.token, { date: tomorrow });
    expect([duplicate.status, duplicate.json.code]).toEqual([409, 'HOLIDAY_EXISTS']);
    const asMember = await add(member.token, { date: addDays(today, 40) });
    expect([asMember.status, asMember.json.code]).toEqual([403, 'GYM_FORBIDDEN']);
    const stranger = await adult('hs');
    expect((await holidays(stranger.token)).json.code).toBe('GYM_NOT_FOUND');
  });

  it('removes future holidays only', async () => {
    const items = (await holidays(owner.token)).json.items as Json[];
    const byDate = (date: string) => items.find((i) => i.date === date)!.id as string;
    const del = (id: string, token = owner.token) => api('DELETE', `/gyms/${gym.id}/holidays/${id}`, { token });

    const locked = await del(byDate(today));
    expect([locked.status, locked.json.code]).toEqual([409, 'HOLIDAY_LOCKED']);
    expect((await del(byDate(tomorrow), member.token)).json.code).toBe('GYM_FORBIDDEN');

    const removed = await del(byDate(tomorrow));
    expect([removed.status, removed.text]).toEqual([204, '']);
    expect((await holidays(owner.token)).json.items).toHaveLength(2);

    expect((await del('33333333-3333-4333-8333-333333333333')).json.code).toBe('HOLIDAY_NOT_FOUND');
    expect((await del('not-a-uuid')).json.code).toBe('HOLIDAY_NOT_FOUND');
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'gym.holiday_removed' } })).toBe(1);
  });
});