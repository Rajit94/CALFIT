import { randomBytes, randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { istDateString } from '../src/common/profile/age.js';
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
const MASKED = /^\+91\*+\d{4}$/;

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

async function signIn(phone = newPhone()): Promise<{ phone: string; token: string; refresh: string }> {
  expect((await api('POST', '/auth/otp/request', { body: { phone } })).status).toBe(200);
  const res = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
  expect(res.status).toBe(200);
  return { phone, token: res.json.accessToken as string, refresh: res.json.refreshToken as string };
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
  refresh: string;
  id: string;
}

// An adult with a completed profile.
async function adult(label: string): Promise<Person> {
  const session = await signIn();
  const res = await api('PUT', '/users/me/profile', {
    token: session.token,
    body: { name: `User ${label}`, username: uname(label), dateOfBirth: dobFor(30) },
  });
  expect(res.status).toBe(200);
  const id = (await prisma.user.findUniqueOrThrow({ where: { phone: session.phone } })).id;
  return { ...session, id };
}

async function createGym(token: string): Promise<Json> {
  const res = await api('POST', '/gyms', {
    token,
    body: { name: `Members Gym ${tag}`, city: 'Jabalpur', latitude: 23.1815, longitude: 79.9864 },
  });
  expect(res.status).toBe(201);
  return res.json;
}

const me = (token: string) => api('GET', '/auth/me', { token });
const list = (token: string, gymId: string, query = '') => api('GET', `/gyms/${gymId}/members${query}`, { token });
const summary = (token: string, gymId: string) => api('GET', `/gyms/${gymId}/members/summary`, { token });
const detail = (token: string, gymId: string, memberId: string) => api('GET', `/gyms/${gymId}/members/${memberId}`, { token });
const add = (owner: Person, gymId: string, name: string, phone: string) =>
  api('POST', `/gyms/${gymId}/members`, { token: owner.token, body: { name, phone } });
const remove = (token: string, gymId: string, memberId: string) =>
  api('DELETE', `/gyms/${gymId}/members/${memberId}`, { token });
const consent = (token: string, gymId: string, whatsappConsent: unknown) =>
  api('PUT', `/gyms/${gymId}/membership/whatsapp-consent`, { token, body: { whatsappConsent } });
const memberRow = (gymId: string, userId: string) =>
  prisma.gymMember.findFirstOrThrow({ where: { gymId, userId, role: 'MEMBER' } });

// Joins with the gym code and has the owner approve, so the person becomes an ACTIVE member.
async function activate(owner: Person, gym: Json, person: Person) {
  const joined = await api('POST', '/gyms/join', { token: person.token, body: { code: gym.code, whatsappConsent: false } });
  expect(joined.status).toBe(200);
  const row = await memberRow(gym.id, person.id);
  const approved = await api('POST', `/gyms/${gym.id}/join-requests/${row.id}/approve`, { token: owner.token });
  expect(approved.status).toBe(200);
  return row;
}

const codes = (res: { json: Json }) => [res.json.code, res.json.details?.map((d: Json) => d.field)];

describe('every members route needs a token', () => {
  it('answers 401 TOKEN_MISSING without one', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const routes: Array<[string, string]> = [
      ['GET', `/gyms/${id}/members`], ['GET', `/gyms/${id}/members/summary`], ['GET', `/gyms/${id}/members/${id}`],
      ['POST', `/gyms/${id}/members`], ['DELETE', `/gyms/${id}/members/${id}`], ['PUT', `/gyms/${id}/membership/whatsapp-consent`],
    ];
    for (const [method, path] of routes) {
      const res = await api(method, path, { body: method === 'POST' || method === 'PUT' ? {} : undefined });
      expect([method, path, res.status, res.json.code]).toEqual([method, path, 401, 'TOKEN_MISSING']);
    }
  });
});

describe('who may use the owner routes', () => {
  it('lets only the owner in; members get 403 and strangers get 404', async () => {
    const owner = await adult('wo');
    const member = await adult('wm');
    const stranger = await adult('ws');
    const gym = await createGym(owner.token);
    const row = await activate(owner, gym, member);

    for (const result of [
      await list(member.token, gym.id), await summary(member.token, gym.id), await detail(member.token, gym.id, row.id),
      await add({ ...owner, token: member.token }, gym.id, 'Sneaky Add', newPhone()), await remove(member.token, gym.id, row.id),
    ]) {
      expect([result.status, result.json.code]).toEqual([403, 'GYM_FORBIDDEN']);
    }
    for (const result of [await list(stranger.token, gym.id), await summary(stranger.token, gym.id), await remove(stranger.token, gym.id, row.id)]) {
      expect([result.status, result.json.code]).toEqual([404, 'GYM_NOT_FOUND']);
    }
    expect((await list(owner.token, 'not-a-uuid')).json.code).toBe('GYM_NOT_FOUND');
    expect((await list(owner.token, gym.id)).status).toBe(200);
  });
});

describe('adding members', () => {
  let owner: Person;
  let gym: Json;

  beforeAll(async () => {
    owner = await adult('ao');
    gym = await createGym(owner.token);
  });

  it('validates the input', async () => {
    expect(codes(await add(owner, gym.id, 'Valid Name', '9876543210'))).toEqual(['VALIDATION_FAILED', ['phone']]);
    expect(codes(await add(owner, gym.id, 'A', newPhone()))).toEqual(['VALIDATION_FAILED', ['name']]);
    const empty = await api('POST', `/gyms/${gym.id}/members`, { token: owner.token, body: {} });
    expect(empty.json.details.map((d: Json) => d.field).sort()).toEqual(['name', 'phone']);
  });

  it('adds an invited member whose phone the owner can read, and rejects duplicates', async () => {
    const phone = newPhone();
    const res = await add(owner, gym.id, 'Imported One', phone);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      status: 'INVITED', registered: false, userId: null, name: 'Imported One', phone,
      whatsappConsent: false, joinedAt: null,
    });
    expect(res.json.phoneMasked).toMatch(MASKED);

    const listed = await list(owner.token, gym.id);
    expect((listed.json.items as Json[]).find((i) => i.memberId === res.json.memberId)).toMatchObject({ phone, status: 'INVITED' });
    expect((await summary(owner.token, gym.id)).json.invited).toBeGreaterThanOrEqual(1);

    const again = await add(owner, gym.id, 'Imported Again', phone);
    expect([again.status, again.json.code]).toEqual([409, 'MEMBER_EXISTS']);
  });

  it('answers MEMBER_EXISTS for people who are already members, without exposing anyone', async () => {
    const member = await adult('am');
    await activate(owner, gym, member);
    const res = await add(owner, gym.id, 'Already Here', member.phone);
    expect([res.status, res.json.code]).toEqual([409, 'MEMBER_EXISTS']);
  });

  it('never reveals whether a number is registered: the new row is unlinked', async () => {
    const registered = await adult('ar');
    const res = await add(owner, gym.id, 'Registered Person', registered.phone);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ registered: false, userId: null, status: 'INVITED' });
    const row = await prisma.gymMember.findUniqueOrThrow({ where: { id: res.json.memberId } });
    expect(row.userId).toBeNull();
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'gym_member.added' } })).toBeGreaterThanOrEqual(2);
  });
});

describe('invited members become active when their phone is linked', () => {
  it('links at the next token refresh', async () => {
    const owner = await adult('lo');
    const person = await adult('lp');
    const gym = await createGym(owner.token);

    const added = await add(owner, gym.id, 'Link At Refresh', person.phone);
    expect(added.status).toBe(201);
    expect((await me(person.token)).json.gyms).toEqual([]);

    const refreshed = await api('POST', '/auth/refresh', { body: { refreshToken: person.refresh } });
    expect(refreshed.status).toBe(200);

    const profile = await me(refreshed.json.accessToken);
    expect(profile.json.gyms).toEqual([{ gymId: gym.id, gymName: gym.name, role: 'MEMBER', status: 'ACTIVE' }]);
    const row = await memberRow(gym.id, person.id);
    expect(row).toMatchObject({ id: added.json.memberId, status: 'ACTIVE', invitedPhone: person.phone });
    expect(row.joinedAt).not.toBeNull();

    expect((await api('GET', `/gyms/${gym.id}`, { token: refreshed.json.accessToken })).status).toBe(200);
    const listed = (await list(owner.token, gym.id)).json.items as Json[];
    expect(listed.find((i) => i.memberId === added.json.memberId)).toMatchObject({ registered: true, status: 'ACTIVE', userId: person.id });
  });

  it('links at the next sign-in', async () => {
    const owner = await adult('so');
    const person = await adult('sp');
    const gym = await createGym(owner.token);

    await add(owner, gym.id, 'Link At Sign In', person.phone);
    expect((await me(person.token)).json.gyms).toEqual([]);

    const again = await signIn(person.phone);
    expect((await me(again.token)).json.gyms).toEqual([{ gymId: gym.id, gymName: gym.name, role: 'MEMBER', status: 'ACTIVE' }]);
  });
});

describe('listing, searching, sorting and paging', () => {
  let owner: Person;
  let gym: Json;
  const people = [
    { name: `Charlie ${tag}`, phone: newPhone() },
    { name: `alpha ${tag}`, phone: newPhone() },
    { name: `Echo ${tag}`, phone: newPhone() },
    { name: `bravo ${tag}`, phone: newPhone() },
    { name: `Delta ${tag}`, phone: newPhone() },
  ];
  const sorted = [`alpha ${tag}`, `bravo ${tag}`, `Charlie ${tag}`, `Delta ${tag}`, `Echo ${tag}`];
  const names = (res: { json: Json }) => (res.json.items as Json[]).map((i) => i.name);

  beforeAll(async () => {
    owner = await adult('io');
    gym = await createGym(owner.token);
    for (const p of people) expect((await add(owner, gym.id, p.name, p.phone)).status).toBe(201);
  });

  it('sorts by name in either direction, ignoring case', async () => {
    expect(names(await list(owner.token, gym.id))).toEqual(sorted);
    expect(names(await list(owner.token, gym.id, '?order=desc'))).toEqual([...sorted].reverse());
  });

  it('searches by name (any case) and by a full phone number', async () => {
    expect(names(await list(owner.token, gym.id, '?q=BRAVO'))).toEqual([`bravo ${tag}`]);
    const byPhone = await list(owner.token, gym.id, `?q=${encodeURIComponent(people[2]!.phone)}`);
    expect(names(byPhone)).toEqual([`Echo ${tag}`]);
    expect(names(await list(owner.token, gym.id, '?q=zzzzzz'))).toEqual([]);
  });

  it('pages through everyone exactly once, and refuses a bad cursor', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await list(owner.token, gym.id, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...names(res));
      cursor = res.json.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(sorted);

    const bad = await list(owner.token, gym.id, '?cursor=garbage');
    expect(codes(bad)).toEqual(['VALIDATION_FAILED', ['cursor']]);
  });

  it('sorts by join date, newest first, with people who have not joined last', async () => {
    const m1 = await adult('j1');
    const m2 = await adult('j2');
    const r1 = await activate(owner, gym, m1);
    const r2 = await activate(owner, gym, m2);
    await prisma.gymMember.update({ where: { id: r1.id }, data: { joinedAt: new Date('2026-10-01T00:00:00.000Z') } });
    await prisma.gymMember.update({ where: { id: r2.id }, data: { joinedAt: new Date('2026-10-02T00:00:00.000Z') } });

    const desc = names(await list(owner.token, gym.id, '?sort=joinDate'));
    expect(desc.slice(0, 2)).toEqual(['User j2', 'User j1']);
    expect(desc).toHaveLength(7);
    const asc = names(await list(owner.token, gym.id, '?sort=joinDate&order=asc'));
    expect(asc.slice(0, 2)).toEqual(['User j1', 'User j2']);
  });

  it('rejects bad query parameters', async () => {
    for (const query of ['?limit=0', '?limit=101', '?sort=age', '?status=GONE', '?order=up']) {
      const res = await list(owner.token, gym.id, query);
      expect([query, res.status, res.json.code]).toEqual([query, 400, 'VALIDATION_FAILED']);
    }
  });

  it('keeps pending requests out of the default list, masked, and impossible to find by phone', async () => {
    const pending = await adult('pn');
    const joined = await api('POST', '/gyms/join', { token: pending.token, body: { code: gym.code, whatsappConsent: false } });
    expect(joined.status).toBe(200);

    expect((await list(owner.token, gym.id)).json.items.some((i: Json) => i.status === 'PENDING')).toBe(false);
    const filtered = await list(owner.token, gym.id, '?status=pending');
    expect(filtered.json.items).toHaveLength(1);
    expect(filtered.json.items[0]).toMatchObject({ status: 'PENDING', phone: null, registered: true });
    expect(filtered.json.items[0].phoneMasked).toMatch(MASKED);
    expect(filtered.text).not.toContain(pending.phone);

    const byPhone = await list(owner.token, gym.id, `?status=PENDING&q=${encodeURIComponent(pending.phone)}`);
    expect(byPhone.json.items).toEqual([]);
  });
});

describe('member details', () => {
  it('shows one member, and answers 404 for anything that is not one of this gym’s members', async () => {
    const owner = await adult('do');
    const other = await adult('dx');
    const gym = await createGym(owner.token);
    const otherGym = await createGym(other.token);
    const added = await add(owner, gym.id, 'Detail Person', newPhone());
    const foreign = await add(other, otherGym.id, 'Foreign Person', newPhone());
    const ownerRow = await prisma.gymMember.findFirstOrThrow({ where: { gymId: gym.id, userId: owner.id, role: 'OWNER' } });

    const res = await detail(owner.token, gym.id, added.json.memberId);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      memberId: added.json.memberId, name: 'Detail Person', status: 'INVITED',
      approvedAt: null, removedAt: null, whatsappConsentAt: null,
    });

    for (const id of ['33333333-3333-4333-8333-333333333333', 'not-a-uuid', foreign.json.memberId, ownerRow.id]) {
      const missing = await detail(owner.token, gym.id, id);
      expect([id, missing.status, missing.json.code]).toEqual([id, 404, 'MEMBER_NOT_FOUND']);
    }
  });
});

describe('removing members and re-inviting them', () => {
  let owner: Person;
  let gym: Json;

  beforeAll(async () => {
    owner = await adult('ro');
    gym = await createGym(owner.token);
  });

  it('ends access at once, clears consent, keeps history, and can be re-invited', async () => {
    const person = await adult('rp');
    const row = await activate(owner, gym, person);
    expect((await consent(person.token, gym.id, true)).status).toBe(200);
    expect((await api('GET', `/gyms/${gym.id}`, { token: person.token })).status).toBe(200);

    const removed = await remove(owner.token, gym.id, row.id);
    expect([removed.status, removed.text]).toEqual([204, '']);

    const gone = await api('GET', `/gyms/${gym.id}`, { token: person.token });
    expect([gone.status, gone.json.code]).toEqual([404, 'GYM_NOT_FOUND']);

    const after = await memberRow(gym.id, person.id);
    expect(after).toMatchObject({ id: row.id, status: 'REMOVED', whatsappConsent: false, whatsappConsentAt: null });
    expect(after.removedAt).not.toBeNull();
    const records = await prisma.consentRecord.findMany({ where: { userId: person.id, gymId: gym.id, type: 'WHATSAPP' } });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.revokedAt !== null)).toBe(true);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'gym_member.removed', entityId: row.id } })).toBe(1);

    expect((await list(owner.token, gym.id)).json.items.some((i: Json) => i.memberId === row.id)).toBe(false);
    const removedList = await list(owner.token, gym.id, '?status=REMOVED');
    expect(removedList.json.items.find((i: Json) => i.memberId === row.id)).toMatchObject({ status: 'REMOVED', phone: null });

    const again = await remove(owner.token, gym.id, row.id);
    expect([again.status, again.json.code]).toEqual([409, 'MEMBER_NOT_REMOVABLE']);

    const tooSoon = await api('POST', '/gyms/join', { token: person.token, body: { code: gym.code, whatsappConsent: false } });
    expect([tooSoon.status, tooSoon.json.code]).toEqual([429, 'JOIN_REQUEST_TOO_SOON']);

    const reAdded = await add(owner, gym.id, 'Back Again', person.phone);
    expect(reAdded.status).toBe(201);
    expect(reAdded.json).toMatchObject({ memberId: row.id, status: 'INVITED', registered: true, name: 'User rp', whatsappConsent: false });
    expect((await me(person.token)).json.gyms).toEqual([{ gymId: gym.id, gymName: gym.name, role: 'MEMBER', status: 'INVITED' }]);

    const rejoined = await api('POST', '/gyms/join', { token: person.token, body: { code: gym.code, whatsappConsent: false } });
    expect(rejoined.json).toMatchObject({ status: 'ACTIVE', autoApproved: true });
    expect((await api('GET', `/gyms/${gym.id}`, { token: person.token })).status).toBe(200);
  });

  it('removes an invited member, and refuses pending requests, the owner’s own row and unknown ids', async () => {
    const invited = await add(owner, gym.id, 'Invited To Remove', newPhone());
    expect((await remove(owner.token, gym.id, invited.json.memberId)).status).toBe(204);
    expect((await detail(owner.token, gym.id, invited.json.memberId)).json.status).toBe('REMOVED');

    const pending = await adult('rq');
    await api('POST', '/gyms/join', { token: pending.token, body: { code: gym.code, whatsappConsent: false } });
    const pendingRow = await memberRow(gym.id, pending.id);
    const notRemovable = await remove(owner.token, gym.id, pendingRow.id);
    expect([notRemovable.status, notRemovable.json.code]).toEqual([409, 'MEMBER_NOT_REMOVABLE']);

    const ownerRow = await prisma.gymMember.findFirstOrThrow({ where: { gymId: gym.id, userId: owner.id, role: 'OWNER' } });
    for (const id of [ownerRow.id, '33333333-3333-4333-8333-333333333333', 'not-a-uuid']) {
      const res = await remove(owner.token, gym.id, id);
      expect([id, res.status, res.json.code]).toEqual([id, 404, 'MEMBER_NOT_FOUND']);
    }
  });

  it('counts every status in the summary', async () => {
    const o = await adult('so2');
    const g = await createGym(o.token);
    await activate(o, g, await adult('s1'));
    const removedRow = await activate(o, g, await adult('s2'));
    await remove(o.token, g.id, removedRow.id);
    await add(o, g.id, 'Invited A', newPhone());
    await add(o, g.id, 'Invited B', newPhone());
    await api('POST', '/gyms/join', { token: (await adult('s3')).token, body: { code: g.code, whatsappConsent: false } });

    expect((await summary(o.token, g.id)).json).toEqual({ active: 1, invited: 2, pending: 1, removed: 1 });
  });
});

describe('WhatsApp consent by the member', () => {
  it('lets a member opt in and out, idempotently, and shows the owner the result', async () => {
    const owner = await adult('co');
    const member = await adult('cm');
    const gym = await createGym(owner.token);
    const row = await activate(owner, gym, member);
    const records = () => prisma.consentRecord.findMany({ where: { userId: member.id, gymId: gym.id, type: 'WHATSAPP' } });

    const on = await consent(member.token, gym.id, true);
    expect([on.status, on.json]).toEqual([200, { whatsappConsent: true }]);
    expect(await memberRow(gym.id, member.id)).toMatchObject({ whatsappConsent: true });
    expect((await memberRow(gym.id, member.id)).whatsappConsentAt).not.toBeNull();
    expect(await records()).toHaveLength(1);
    expect((await detail(owner.token, gym.id, row.id)).json.whatsappConsent).toBe(true);

    expect((await consent(member.token, gym.id, true)).status).toBe(200);
    expect(await records()).toHaveLength(1);

    const off = await consent(member.token, gym.id, false);
    expect([off.status, off.json]).toEqual([200, { whatsappConsent: false }]);
    expect(await memberRow(gym.id, member.id)).toMatchObject({ whatsappConsent: false, whatsappConsentAt: null });
    expect((await records()).every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('validates the body and refuses people who are not members', async () => {
    const owner = await adult('cv');
    const member = await adult('cw');
    const stranger = await adult('cx');
    const gym = await createGym(owner.token);
    await activate(owner, gym, member);

    expect(codes(await consent(member.token, gym.id, 'yes'))).toEqual(['VALIDATION_FAILED', ['whatsappConsent']]);
    expect(codes(await api('PUT', `/gyms/${gym.id}/membership/whatsapp-consent`, { token: member.token, body: {} }))).toEqual(['VALIDATION_FAILED', ['whatsappConsent']]);

    const asOwner = await consent(owner.token, gym.id, true);
    expect([asOwner.status, asOwner.json.code]).toEqual([404, 'MEMBERSHIP_NOT_FOUND']);
    const asStranger = await consent(stranger.token, gym.id, true);
    expect([asStranger.status, asStranger.json.code]).toEqual([404, 'GYM_NOT_FOUND']);
  });
});

describe('read-only gyms', () => {
  it('blocks adding and removing, but still lets the owner read and members manage their consent', async () => {
    const owner = await adult('xo');
    const member = await adult('xm');
    const gym = await createGym(owner.token);
    const row = await activate(owner, gym, member);
    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'READ_ONLY' } });

    const blockedAdd = await add(owner, gym.id, 'Blocked Add', newPhone());
    expect([blockedAdd.status, blockedAdd.json.code]).toEqual([403, 'GYM_READ_ONLY']);
    const blockedRemove = await remove(owner.token, gym.id, row.id);
    expect([blockedRemove.status, blockedRemove.json.code]).toEqual([403, 'GYM_READ_ONLY']);

    expect((await list(owner.token, gym.id)).status).toBe(200);
    expect((await summary(owner.token, gym.id)).status).toBe(200);
    expect((await detail(owner.token, gym.id, row.id)).status).toBe(200);
    expect((await consent(member.token, gym.id, true)).status).toBe(200);
    expect((await memberRow(gym.id, member.id)).status).toBe('ACTIVE');
  });
});