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
      await prisma.appConfig.deleteMany({ where: { key: 'consent.parental' } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } }); // consents + guardian rows cascade
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
  return { status: res.status, json };
}

async function signIn(phone = newPhone()): Promise<{ phone: string; token: string }> {
  expect((await api('POST', '/auth/otp/request', { body: { phone } })).status).toBe(200);
  const res = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
  expect(res.status).toBe(200);
  return { phone, token: res.json.accessToken as string };
}

// A date of birth that makes the person `ageYears` old today (IST), with some margin.
function dobFor(ageYears: number, extraDays = 30): string {
  const d = new Date(`${istDateString()}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - ageYears);
  d.setUTCDate(d.getUTCDate() - extraDays);
  return d.toISOString().slice(0, 10);
}

const me = (token: string) => api('GET', '/auth/me', { token });
const put = (token: string, body: unknown) => api('PUT', '/users/me/profile', { token, body });
const patch = (token: string, body: unknown) => api('PATCH', '/users/me/profile', { token, body });
const userIdOf = async (phone: string) => (await prisma.user.findUniqueOrThrow({ where: { phone } })).id;
const codes = (res: { json: Json }) => [res.json.code, res.json.details?.map((d: Json) => d.field)];

describe('profile setup and edit (adult)', () => {
  const dob = dobFor(30);
  const username = uname('a');
  let phone = '';
  let token = '';

  it('shows profile details as the next step for a brand-new user', async () => {
    ({ phone, token } = await signIn());
    const profile = await me(token);
    expect(profile.json).toMatchObject({
      profileCompleted: false, profileNextStep: 'PROFILE_DETAILS', dateOfBirth: null, ageGroup: null,
    });
    expect(profile.json.guardianConsent).toEqual({ required: false, status: 'NOT_REQUIRED', guardianPhoneMasked: null });
  });

  it('protects every profile route', async () => {
    expect((await api('PUT', '/users/me/profile', { body: {} })).json.code).toBe('TOKEN_MISSING');
    expect((await api('PATCH', '/users/me/profile', { body: {} })).json.code).toBe('TOKEN_MISSING');
    expect((await api('GET', '/users/username-available?username=abc')).json.code).toBe('TOKEN_MISSING');
    expect((await api('POST', '/users/me/guardian', { body: {} })).json.code).toBe('TOKEN_MISSING');
    expect((await api('POST', '/users/me/guardian/verify', { body: {} })).json.code).toBe('TOKEN_MISSING');
  });

  it('checks username availability and explains invalid usernames', async () => {
    const free = await api('GET', `/users/username-available?username=${username}`, { token });
    expect([free.status, free.json]).toEqual([200, { username, available: true }]);
    for (const bad of ['admin', 'ab', 'bad-name!']) {
      const res = await api('GET', `/users/username-available?username=${encodeURIComponent(bad)}`, { token });
      expect(res.status).toBe(400);
      expect(codes(res)).toEqual(['VALIDATION_FAILED', ['username']]);
    }
    expect((await api('GET', '/users/username-available', { token })).status).toBe(400);
  });

  it('rejects bad dates of birth and missing fields without saving anything', async () => {
    const base = { name: 'Test User', username };
    expect(codes(await put(token, {}))[0]).toBe('VALIDATION_FAILED');
    const missing = await put(token, {});
    expect(missing.json.details.map((d: Json) => d.field).sort()).toEqual(['dateOfBirth', 'name', 'username']);
    expect(codes(await put(token, { ...base, username: 'admin', dateOfBirth: dob }))).toEqual(['VALIDATION_FAILED', ['username']]);
    expect((await put(token, { ...base, dateOfBirth: '2001-02-30' })).json.code).toBe('VALIDATION_FAILED');

    const future = await put(token, { ...base, dateOfBirth: '2999-01-01' });
    expect([future.status, future.json.code]).toEqual([400, 'DATE_OF_BIRTH_INVALID']);
    const ancient = await put(token, { ...base, dateOfBirth: '1900-01-01' });
    expect([ancient.status, ancient.json.code]).toEqual([400, 'DATE_OF_BIRTH_INVALID']);
    const child = await put(token, { ...base, dateOfBirth: dobFor(9) });
    expect([child.status, child.json.code]).toEqual([403, 'AGE_TOO_YOUNG']);

    const after = await me(token);
    expect(after.json).toMatchObject({ dateOfBirth: null, profileNextStep: 'PROFILE_DETAILS' });
  });

  it('completes the profile; the username is lowercased and the name tidied', async () => {
    const res = await put(token, { name: '  Rajit   Kumar ', username: username.toUpperCase(), dateOfBirth: dob, bio: 'Lifting daily' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      username, name: 'Rajit Kumar', bio: 'Lifting daily', privacy: 'PUBLIC', dateOfBirth: dob,
      ageGroup: 'ADULT', profileCompleted: true, profileNextStep: 'DONE',
    });
    const profile = await me(token);
    expect(profile.json).toMatchObject({ username, profileCompleted: true, profileNextStep: 'DONE', ageGroup: 'ADULT', dateOfBirth: dob });
  });

  it('refuses to set the profile up twice', async () => {
    const res = await put(token, { name: 'Again Person', username: uname('z'), dateOfBirth: dob });
    expect([res.status, res.json.code]).toEqual([409, 'PROFILE_ALREADY_COMPLETED']);
  });

  it('edits name, bio and privacy, and clears the bio', async () => {
    const res = await patch(token, { name: 'Rajit K', bio: 'New bio', privacy: 'PRIVATE' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ name: 'Rajit K', bio: 'New bio', privacy: 'PRIVATE' });
    expect((await patch(token, { bio: '' })).json.bio).toBeNull();
    expect((await patch(token, { privacy: 'PUBLIC' })).json.privacy).toBe('PUBLIC');
  });

  it('rejects empty updates and any attempt to change the date of birth', async () => {
    expect((await patch(token, {})).json.code).toBe('VALIDATION_FAILED');
    const locked = await patch(token, { dateOfBirth: '1990-01-01' });
    expect([locked.status, locked.json.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await me(token)).json.dateOfBirth).toBe(dob);
  });

  it('allows one username change per 30 days and records it', async () => {
    const changed = await patch(token, { username: uname('a2') });
    expect([changed.status, changed.json.username]).toEqual([200, uname('a2')]);
    const tooSoon = await patch(token, { username: uname('a3') });
    expect([tooSoon.status, tooSoon.json.code]).toEqual([429, 'USERNAME_CHANGE_TOO_SOON']);
    expect((await patch(token, { username: uname('a2') })).status).toBe(200); // unchanged: fine
    const userId = await userIdOf(phone);
    expect(await prisma.auditLog.count({ where: { actorId: userId, action: 'user.username_changed' } })).toBe(1);
  });

  it('refuses a username that another user already has', async () => {
    const other = await signIn();
    const setup = await put(other.token, { name: 'Other Person', username: uname('b'), dateOfBirth: dobFor(28) });
    expect(setup.status).toBe(200);
    const taken = await patch(other.token, { username: uname('a2') });
    expect([taken.status, taken.json.code]).toEqual([409, 'USERNAME_TAKEN']);
    const available = await api('GET', `/users/username-available?username=${uname('a2')}`, { token: other.token });
    expect(available.json.available).toBe(false);
    expect(await prisma.auditLog.count({ where: { actorId: await userIdOf(other.phone), action: 'user.username_changed' } })).toBe(0);
  });

  it('asks for setup before editing, and says guardian consent is not needed for adults', async () => {
    const fresh = await signIn();
    const early = await patch(fresh.token, { name: 'Too Early' });
    expect([early.status, early.json.code]).toEqual([409, 'PROFILE_NOT_COMPLETED']);

    const guardian = await api('POST', '/users/me/guardian', {
      token, body: { guardianName: 'Some Person', guardianPhone: newPhone() },
    });
    expect([guardian.status, guardian.json.code]).toEqual([409, 'GUARDIAN_NOT_REQUIRED']);
  });
});

describe('profile setup for under-18s (guardian consent)', () => {
  const dob = dobFor(15);
  const guardianPhone = newPhone();
  let phone = '';
  let token = '';
  const guardian = (body: Json = {}) =>
    api('POST', '/users/me/guardian', { token, body: { guardianName: 'Asha Kumar', guardianPhone, ...body } });
  const verify = (code: string) => api('POST', '/users/me/guardian/verify', { token, body: { code } });

  it('saves the details but leaves the profile incomplete and private', async () => {
    ({ phone, token } = await signIn());
    const res = await put(token, { name: 'Young Person', username: uname('m'), dateOfBirth: dob });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      privacy: 'PRIVATE', ageGroup: 'MINOR', profileCompleted: false, profileNextStep: 'GUARDIAN_CONSENT',
    });
    expect(res.json.guardianConsent).toMatchObject({ required: true, status: 'NOT_STARTED' });
  });

  it('refuses edits until the profile is complete, and locks the date of birth', async () => {
    const early = await patch(token, { name: 'Edit Early' });
    expect([early.status, early.json.code]).toEqual([409, 'PROFILE_NOT_COMPLETED']);
    const locked = await put(token, { name: 'Young Person', username: uname('m'), dateOfBirth: dobFor(30) });
    expect([locked.status, locked.json.code]).toEqual([409, 'DATE_OF_BIRTH_LOCKED']);
  });

  it('validates the guardian request', async () => {
    expect((await verify('123456')).json.code).toBe('GUARDIAN_NOT_REQUESTED');
    const own = await guardian({ guardianPhone: phone });
    expect([own.status, own.json.code]).toEqual([400, 'GUARDIAN_PHONE_INVALID']);
    expect(codes(await guardian({ guardianPhone: '9876543210' }))).toEqual(['VALIDATION_FAILED', ['guardianPhone']]);
  });

  it('sends a code to the guardian and reports the pending state', async () => {
    const res = await guardian();
    expect(res.status).toBe(200);
    expect(res.json.guardianPhoneMasked).toMatch(/^\+91\*+\d{4}$/);
    expect(res.json.guardianPhoneMasked).not.toBe(guardianPhone);
    expect(res.json.expiresInSeconds).toBe(300);

    const profile = await me(token);
    expect(profile.json).toMatchObject({ profileNextStep: 'GUARDIAN_VERIFICATION', profileCompleted: false });
    expect(profile.json.guardianConsent.status).toBe('PENDING');
  });

  it('rejects a wrong code, then completes the profile with the right one', async () => {
    const wrong = await verify('000000');
    expect([wrong.status, wrong.json.code]).toEqual([400, 'OTP_INVALID']);
    expect((await me(token)).json.profileCompleted).toBe(false);

    const ok = await verify('123456');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ profileCompleted: true, profileNextStep: 'DONE', privacy: 'PRIVATE' });
    expect(ok.json.guardianConsent.status).toBe('VERIFIED');

    const userId = await userIdOf(phone);
    const consent = await prisma.parentalConsent.findUniqueOrThrow({ where: { userId } });
    expect(consent.verifiedAt).not.toBeNull();
    const records = await prisma.consentRecord.findMany({ where: { userId, type: 'PARENTAL' } });
    expect(records).toHaveLength(1);
    expect(records[0]?.version).toBe('guardian-otp-v1');
  });

  it('keeps the account private after completion, and records consent only once', async () => {
    const goPublic = await patch(token, { privacy: 'PUBLIC' });
    expect([goPublic.status, goPublic.json.code]).toEqual([403, 'MINOR_MUST_BE_PRIVATE']);
    expect((await patch(token, { bio: 'Training hard' })).status).toBe(200);

    const again = await guardian();
    expect([again.status, again.json.code]).toEqual([409, 'GUARDIAN_ALREADY_VERIFIED']);
    const verifyAgain = await verify('123456');
    expect([verifyAgain.status, verifyAgain.json.code]).toEqual([409, 'GUARDIAN_ALREADY_VERIFIED']);
  });
});

describe('guardian consent can be configured', () => {
  it('lets a minor complete the profile directly when the policy is switched off, then restores the default', async () => {
    await prisma.appConfig.upsert({
      where: { key: 'consent.parental' },
      create: { key: 'consent.parental', value: { enabled: false } },
      update: { value: { enabled: false } },
    });
    try {
      const { token } = await signIn();
      const res = await put(token, { name: 'Config Test', username: uname('c'), dateOfBirth: dobFor(14) });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ privacy: 'PRIVATE', profileCompleted: true, profileNextStep: 'DONE' });
      expect(res.json.guardianConsent.status).toBe('NOT_REQUIRED');
    } finally {
      await prisma.appConfig.deleteMany({ where: { key: 'consent.parental' } });
    }

    const { token } = await signIn();
    const res = await put(token, { name: 'Default Again', username: uname('d'), dateOfBirth: dobFor(14) });
    expect(res.json).toMatchObject({ profileCompleted: false, profileNextStep: 'GUARDIAN_CONSENT' });
  });
});