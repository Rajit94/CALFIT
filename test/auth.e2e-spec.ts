import { createHmac, randomBytes, randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ALLOWED_TEST_DATABASES, E2E_JWT_SECRET } from './support/e2e-env.js';

// The database guard already ran (see test/support/e2e-setup.ts) before this file was loaded.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: INestApplication;
let prisma: PrismaService;
let baseUrl = '';

const runTag = `E2E${randomBytes(3).toString('hex').toUpperCase()}`;
const phones: string[] = [];

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

  // Second safety layer: confirm which database we are really connected to BEFORE writing anything.
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
      await prisma.gym.deleteMany({ where: { code: { startsWith: runTag } } }); // memberships cascade
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } }); // sessions + consents cascade
    }
  } finally {
    await app?.close();
  }
});

// ---------------------------------------------------------------- helpers

function newPhone(): string {
  const phone = `+919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  phones.push(phone);
  return phone;
}

async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
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
  return { status: res.status, headers: res.headers, json, text };
}

async function signIn(phone: string, device = 'e2e') {
  const requested = await api('POST', '/auth/otp/request', { body: { phone } });
  expect(requested.status).toBe(200);
  const res = await api('POST', '/auth/otp/verify', {
    body: { phone, code: '123456', acceptedTerms: true, device: { name: device, platform: 'web' } },
  });
  expect(res.status).toBe(200);
  return { access: res.json.accessToken as string, refresh: res.json.refreshToken as string, body: res.json };
}

type Session = Awaited<ReturnType<typeof signIn>>;
const me = (s: Session) => api('GET', '/auth/me', { token: s.access });
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString()) as { sub: string; sid: string };
const userIdOf = async (phone: string) => (await prisma.user.findUniqueOrThrow({ where: { phone } })).id;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function forge(mode: 'wrongsecret' | 'none' | 'expired' | 'tampered', real: string): string {
  const parts = real.split('.');
  const claims = claimsOf(real);
  const now = Math.floor(Date.now() / 1000);
  const sign = (payload: object, key: string) => {
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
    return `${data}.${createHmac('sha256', key).update(data).digest('base64url')}`;
  };
  if (mode === 'wrongsecret') return sign({ ...claims, iat: now, exp: now + 900 }, 'x'.repeat(40));
  if (mode === 'expired') return sign({ ...claims, iat: now - 1000, exp: now - 10 }, E2E_JWT_SECRET);
  if (mode === 'none') return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iat: now, exp: now + 900 })}.`;
  return `${parts[0]}.${b64({ ...claims, sid: '99999999-9999-4999-8999-999999999999' })}.${parts[2]}`;
}

// ------------------------------------------------------------------ tests

describe('public routes and the error contract', () => {
  it('serves the health check and the root route without a token', async () => {
    const health = await api('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ status: 'ok', database: 'up' });
    const root = await api('GET', '');
    expect(root.status).toBe(200);
    expect(root.text).toBe('Hello World!');
  });

  it('answers validation errors in the standard format with a request id', async () => {
    const res = await api('POST', '/auth/otp/request', { body: { phone: '9876543210' } });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('VALIDATION_FAILED');
    expect(res.json.details?.[0]?.field).toBe('phone');
    expect(res.json.requestId).toBe(res.headers.get('x-request-id'));
    expect(res.text).not.toContain('stack');
  });

  it('requires the terms to be accepted on verify', async () => {
    const res = await api('POST', '/auth/otp/verify', {
      body: { phone: newPhone(), code: '123456', acceptedTerms: false },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('VALIDATION_FAILED');
    expect(res.json.details?.some((d: Json) => d.field === 'acceptedTerms')).toBe(true);
  });

  it('answers unknown routes with the standard 404 and strips the query string', async () => {
    const res = await api('GET', '/nope?token=secret123');
    expect(res.status).toBe(404);
    expect(Object.keys(res.json).sort()).toEqual(
      ['code', 'error', 'message', 'path', 'requestId', 'statusCode', 'timestamp'].sort(),
    );
    expect(res.json.code).toBe('NOT_FOUND');
    expect(res.json.path).toBe('/api/v1/nope');
    expect(res.text).not.toContain('secret123');
  });

  it('reuses a valid incoming request id and replaces an invalid one', async () => {
    const good = await api('GET', '/nope', { headers: { 'x-request-id': 'e2e-request-12345' } });
    expect(good.json.requestId).toBe('e2e-request-12345');
    const bad = await api('GET', '/nope', { headers: { 'x-request-id': 'short' } });
    expect(bad.json.requestId).not.toBe('short');
    expect(bad.json.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('sign-in and /auth/me', () => {
  it('creates a new user, records consent, and returns only safe fields from /auth/me', async () => {
    const phone = newPhone();
    const s = await signIn(phone);

    expect(s.body).toMatchObject({ isNewUser: true, tokenType: 'Bearer', expiresIn: 900 });
    expect(s.body.user.profileCompleted).toBe(false);
    expect(JSON.stringify(s.body)).not.toContain('refreshTokenHash');

    const profile = await me(s);
    expect(profile.status).toBe(200);
    expect(profile.json.phone).toBe(phone);
    expect(profile.json.gyms).toEqual([]);
    expect(Object.keys(profile.json).sort()).toEqual(
      ['avatarUrl', 'bio', 'createdAt', 'gyms', 'id', 'name', 'phone', 'privacy', 'profileCompleted', 'username'].sort(),
    );

    const consents = await prisma.consentRecord.findMany({ where: { user: { phone } } });
    expect(consents.map((c) => c.type).sort()).toEqual(['PRIVACY', 'TERMS']);
    const sessions = await prisma.session.findMany({ where: { user: { phone } } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.refreshTokenHash).toHaveLength(64);
    expect(sessions[0]?.refreshTokenHash).not.toBe(s.refresh);
  });

  it('signs an existing user in again with different tokens', async () => {
    const phone = newPhone();
    const first = await signIn(phone);
    const second = await signIn(phone, 'second device');
    expect(second.body.isNewUser).toBe(false);
    expect(second.access).not.toBe(first.access);
    expect(second.refresh).not.toBe(first.refresh);
    expect((await me(first)).status).toBe(200);
    expect((await me(second)).status).toBe(200);
  });
});

describe('OTP protections', () => {
  it('rejects a wrong code and a reused code', async () => {
    const phone = newPhone();
    await api('POST', '/auth/otp/request', { body: { phone } });
    const wrong = await api('POST', '/auth/otp/verify', { body: { phone, code: '000000', acceptedTerms: true } });
    expect([wrong.status, wrong.json.code]).toEqual([400, 'OTP_INVALID']);
    const ok = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
    expect(ok.status).toBe(200);
    const reuse = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
    expect([reuse.status, reuse.json.code]).toEqual([400, 'OTP_EXPIRED']);
  });

  it('locks a code after too many wrong attempts, even for the right code', async () => {
    const phone = newPhone();
    await api('POST', '/auth/otp/request', { body: { phone } });
    for (let i = 0; i < 3; i++) {
      const r = await api('POST', '/auth/otp/verify', { body: { phone, code: '000000', acceptedTerms: true } });
      expect(r.json.code).toBe('OTP_INVALID');
    }
    const locked = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
    expect([locked.status, locked.json.code]).toEqual([429, 'OTP_ATTEMPTS_EXCEEDED']);
  });

  it('limits how many codes one phone can request per hour', async () => {
    const phone = newPhone();
    for (let i = 0; i < 6; i++) {
  const response = await api('POST', '/auth/otp/request', {
    body: { phone },
  });

  if (response.status !== 200) {
    console.log('OTP DIAGNOSTIC:', {
      requestNumber: i + 1,
      status: response.status,
      response: response.json,
    });
  }

  expect(response.status).toBe(200);
}
    const seventh = await api('POST', '/auth/otp/request', { body: { phone } });
    expect([seventh.status, seventh.json.code]).toEqual([429, 'OTP_PHONE_LIMIT_REACHED']);
  });

  it('rejects verification when no code was requested', async () => {
    const r = await api('POST', '/auth/otp/verify', {
      body: { phone: newPhone(), code: '123456', acceptedTerms: true },
    });
    expect([r.status, r.json.code]).toEqual([400, 'OTP_EXPIRED']);
  });
});

describe('the access-token guard', () => {
  it('rejects missing, malformed and wrong-scheme tokens', async () => {
    const none = await api('GET', '/auth/me');
    expect([none.status, none.json.code]).toEqual([401, 'TOKEN_MISSING']);
    const garbage = await api('GET', '/auth/me', { token: 'not.a.jwt' });
    expect([garbage.status, garbage.json.code]).toEqual([401, 'TOKEN_INVALID']);
    const s = await signIn(newPhone());
    const scheme = await api('GET', '/auth/me', { headers: { authorization: `Token ${s.access}` } });
    expect([scheme.status, scheme.json.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it.each([
    ['wrongsecret', 'TOKEN_INVALID'],
    ['none', 'TOKEN_INVALID'],
    ['tampered', 'TOKEN_INVALID'],
    ['expired', 'TOKEN_EXPIRED'],
  ] as const)('rejects a %s token with %s', async (mode, code) => {
    const s = await signIn(newPhone());
    const res = await api('GET', '/auth/me', { token: forge(mode, s.access) });
    expect([res.status, res.json.code]).toEqual([401, code]);
  });
});

describe('refresh rotation and reuse detection', () => {
  it('rotates tokens: the old access token dies, the new one works', async () => {
    const s = await signIn(newPhone());
    const refreshed = await api('POST', '/auth/refresh', { body: { refreshToken: s.refresh } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.refreshToken).not.toBe(s.refresh);
    const old = await me(s);
    expect([old.status, old.json.code]).toEqual([401, 'SESSION_REVOKED']);
    const fresh = await api('GET', '/auth/me', { token: refreshed.json.accessToken });
    expect(fresh.status).toBe(200);
  });

  it('treats a replayed refresh token as theft: revokes every session and writes one audit entry', async () => {
    const phone = newPhone();
    const phoneSession = await signIn(phone, 'phone');
    const tablet = await signIn(phone, 'tablet');
    const rotated = await api('POST', '/auth/refresh', { body: { refreshToken: phoneSession.refresh } });
    expect(rotated.status).toBe(200);

    const replay = await api('POST', '/auth/refresh', { body: { refreshToken: phoneSession.refresh } });
    expect([replay.status, replay.json.code]).toEqual([401, 'REFRESH_TOKEN_REUSED']);

    expect((await api('GET', '/auth/me', { token: rotated.json.accessToken })).json.code).toBe('SESSION_REVOKED');
    expect((await me(tablet)).json.code).toBe('SESSION_REVOKED');

    const userId = await userIdOf(phone);
    expect(await prisma.session.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { actorId: userId, action: 'auth.refresh_reuse_detected' } }),
    ).toBe(1);
  });

  it('rejects garbage tokens and empty bodies', async () => {
    const garbage = await api('POST', '/auth/refresh', { body: { refreshToken: 'garbage' } });
    expect([garbage.status, garbage.json.code]).toEqual([401, 'REFRESH_TOKEN_INVALID']);
    const empty = await api('POST', '/auth/refresh', { body: {} });
    expect([empty.status, empty.json.code]).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('logout', () => {
  it('signs out one device without affecting the other, and raises no theft alarm', async () => {
    const phone = newPhone();
    const a = await signIn(phone, 'A');
    const b = await signIn(phone, 'B');

    const out = await api('POST', '/auth/logout', { body: { refreshToken: a.refresh } });
    expect(out.status).toBe(204);
    expect(out.text).toBe('');

    expect((await me(a)).json.code).toBe('SESSION_REVOKED');
    expect((await me(b)).status).toBe(200);

    const stale = await api('POST', '/auth/refresh', { body: { refreshToken: a.refresh } });
    expect([stale.status, stale.json.code]).toEqual([401, 'REFRESH_TOKEN_INVALID']);

    const userId = await userIdOf(phone);
    expect(await prisma.auditLog.count({ where: { actorId: userId } })).toBe(0);
  });

  it('signs out every device, and stale tokens never kill a newer session', async () => {
    const phone = newPhone();
    const sessions = [await signIn(phone, '1'), await signIn(phone, '2'), await signIn(phone, '3')];

    const all = await api('POST', '/auth/logout-all', { token: sessions[2]?.access });
    expect(all.status).toBe(200);
    expect(all.json.revokedSessions).toBe(3);

    for (const s of sessions) {
      expect((await me(s)).json.code).toBe('SESSION_REVOKED');
      const stale = await api('POST', '/auth/refresh', { body: { refreshToken: s.refresh } });
      expect([stale.status, stale.json.code]).toEqual([401, 'REFRESH_TOKEN_INVALID']);
    }

    const fresh = await signIn(phone, 'new device');
    expect((await me(fresh)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { actorId: await userIdOf(phone) } })).toBe(0);
  });

  it('answers logout with 204 for any token, and protects logout-all', async () => {
    expect((await api('POST', '/auth/logout', { body: { refreshToken: 'garbage' } })).status).toBe(204);
    const noToken = await api('POST', '/auth/logout-all');
    expect([noToken.status, noToken.json.code]).toEqual([401, 'TOKEN_MISSING']);
  });
});

describe('account and session status', () => {
  it('blocks a suspended account everywhere and restores access when reactivated', async () => {
    const phone = newPhone();
    const s = await signIn(phone);
    await prisma.user.update({ where: { phone }, data: { status: 'SUSPENDED' } });

    const profile = await me(s);
    expect([profile.status, profile.json.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
    const refresh = await api('POST', '/auth/refresh', { body: { refreshToken: s.refresh } });
    expect([refresh.status, refresh.json.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
    await api('POST', '/auth/otp/request', { body: { phone } });
    const verify = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
    expect([verify.status, verify.json.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);

    await prisma.user.update({ where: { phone }, data: { status: 'ACTIVE' } });
    expect((await me(s)).status).toBe(200);
  });

  it('blocks a deleted account', async () => {
    const phone = newPhone();
    const s = await signIn(phone);
    await prisma.user.update({ where: { phone }, data: { status: 'DELETED' } });
    const profile = await me(s);
    expect([profile.status, profile.json.code]).toEqual([403, 'ACCOUNT_DELETED']);
  });

  it('rejects a session whose lifetime has ended', async () => {
    const s = await signIn(newPhone());
    await prisma.session.update({
      where: { id: claimsOf(s.access).sid },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const profile = await me(s);
    expect([profile.status, profile.json.code]).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('linking invited memberships by phone', () => {
  const phone = newPhone();
  const otherPhone = newPhone();
  const names: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let session: Session;
  let userId = '';

  const gymList = async () =>
    ((await me(session)).json.gyms as Json[]).map((g) => `${g.gymName}|${g.role}|${g.status}`).sort();
  const auditCount = (action: string) => prisma.auditLog.count({ where: { actorId: userId, action } });

  it('sets up: the person signs up first, then invitations arrive', async () => {
    session = await signIn(phone, 'link test');
    userId = await userIdOf(phone);

    const creator = await prisma.user.create({ data: { phone: newPhone() } });
    for (const key of ['One', 'Two', 'Three', 'Four']) {
      names[key] = `${runTag} ${key}`;
      const gym = await prisma.gym.create({
        data: {
          name: names[key] as string,
          code: `${runTag}${key.toUpperCase().slice(0, 3)}`,
          latitude: 23.18,
          longitude: 79.98,
          qrSecret: 'e2e-test-secret',
          createdById: creator.id,
        },
      });
      ids[key] = gym.id;
    }

    await prisma.gymMember.createMany({
      data: [
        { gymId: ids.One as string, role: 'MEMBER', status: 'INVITED', invitedPhone: phone, invitedName: 'Imported One' },
        { gymId: ids.One as string, role: 'TRAINER', status: 'INVITED', invitedPhone: phone },
        { gymId: ids.One as string, role: 'MEMBER', status: 'INVITED', invitedPhone: otherPhone },
        { gymId: ids.Two as string, role: 'MEMBER', status: 'INVITED', invitedPhone: phone, joinedAt: new Date('2026-09-01T00:00:00.000Z') },
        { gymId: ids.Two as string, role: 'OWNER', status: 'INVITED', invitedPhone: phone },
        { gymId: ids.Three as string, role: 'MEMBER', status: 'REMOVED', invitedPhone: phone },
        { gymId: ids.Four as string, role: 'MEMBER', status: 'ACTIVE', userId },
        { gymId: ids.Four as string, role: 'MEMBER', status: 'INVITED', invitedPhone: phone },
      ],
    });
    expect(await gymList()).toEqual([
  `${names.Four}|MEMBER|ACTIVE`,
]);
  });

  it('links on the next sign-in: members activate, trainers stay invited, owners and others are untouched', async () => {
    session = await signIn(phone, 'link test 2');

    expect(await gymList()).toEqual(
      [
        `${names.One}|MEMBER|ACTIVE`,
        `${names.One}|TRAINER|INVITED`,
        `${names.Two}|MEMBER|ACTIVE`,
        `${names.Four}|MEMBER|ACTIVE`,
      ].sort(),
    );

    const row = (gym: string, role: string, invitedPhone: string) =>
      prisma.gymMember.findFirstOrThrow({ where: { gymId: ids[gym] as string, role: role as 'MEMBER', invitedPhone } });

    const imported = await row('One', 'MEMBER', phone);
    expect(imported.userId).toBe(userId);
    expect(Math.abs((imported.joinedAt as Date).getTime() - Date.now())).toBeLessThan(60_000);
    expect((await row('Two', 'MEMBER', phone)).joinedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect((await row('One', 'TRAINER', phone)).status).toBe('INVITED');

    expect((await row('Two', 'OWNER', phone)).userId).toBeNull();
    const removed = await row('Three', 'MEMBER', phone);
    expect([removed.userId, removed.status]).toEqual([null, 'REMOVED']);
    expect((await row('One', 'MEMBER', otherPhone)).userId).toBeNull();
    const duplicate = await row('Four', 'MEMBER', phone);
    expect([duplicate.userId, duplicate.status]).toEqual([null, 'INVITED']);

    expect(await auditCount('gym_member.linked_by_phone')).toBe(1);
    expect(await auditCount('gym_member.link_conflict')).toBe(1);
    const linked = await prisma.auditLog.findFirstOrThrow({ where: { actorId: userId, action: 'gym_member.linked_by_phone' } });
    expect((linked.metadata as Json).count).toBe(3);
  });

  it('is idempotent: another sign-in changes nothing and reports the conflict only once', async () => {
    session = await signIn(phone, 'link test 3');
    expect(await gymList()).toHaveLength(4);
    expect(await auditCount('gym_member.linked_by_phone')).toBe(1);
    expect(await auditCount('gym_member.link_conflict')).toBe(1);
  });
});