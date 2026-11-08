import { HttpException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RefreshService } from './refresh.service.js';
import { generateRefreshToken, hashRefreshToken } from './token.crypto.js';

const SECRET = 's'.repeat(32);
const USER = 'user-1';
const BOB = 'user-2';
const client = { ip: '5.6.7.8', userAgent: 'TestAgent/1.0' };
const DAY = 86_400_000;

interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  deviceName: string | null;
  platform: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

// In-memory stand-ins for the sessions, users and audit_logs tables.
function makeEnv() {
  const users = new Map<string, { id: string; status: string }>();
  const sessions: SessionRow[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const db = {
    session: {
      findUnique: async ({ where }: { where: { refreshTokenHash: string } }) => {
        const s = sessions.find((x) => x.refreshTokenHash === where.refreshTokenHash);
        if (!s) return null;
        return { ...s, user: { status: users.get(s.userId)?.status ?? 'ACTIVE' } };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; userId?: string; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        const hit = sessions.filter(
          (s) =>
            (where.id === undefined || s.id === where.id) &&
            (where.userId === undefined || s.userId === where.userId) &&
            s.revokedAt === null,
        );
        for (const s of hit) s.revokedAt = data.revokedAt;
        return { count: hit.length };
      },
      create: async ({
        data,
      }: {
        data: Omit<SessionRow, 'id' | 'revokedAt' | 'createdAt'>;
      }) => {
        const row: SessionRow = {
          id: `new${sessions.length + 1}`,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        sessions.push(row);
        return row;
      },
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
  };
  const prisma = { ...db, $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };

  const values: Record<string, unknown> = { JWT_ACCESS_TTL_SECONDS: 900, REFRESH_TTL_DAYS: 30 };
  const config = { get: (key: string) => values[key] };
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } });
  const service = new RefreshService(prisma as never, config as never, jwt);

  function seed(opts: {
    id: string;
    userId?: string;
    token: string;
    expiresAt?: Date;
    revokedAt?: Date | null;
    deviceName?: string | null;
    platform?: string | null;
  }): SessionRow {
    const row: SessionRow = {
      id: opts.id,
      userId: opts.userId ?? USER,
      refreshTokenHash: hashRefreshToken(opts.token),
      deviceName: opts.deviceName ?? null,
      platform: opts.platform ?? null,
      ip: null,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 10 * DAY),
      revokedAt: opts.revokedAt ?? null,
      createdAt: new Date(),
    };
    sessions.push(row);
    return row;
  }

  return { db, service, jwt, users, sessions, audits, seed };
}

async function reject(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code };
  }
  throw new Error('Expected the promise to reject');
}

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('RefreshService.refresh: rotation', () => {
  it('revokes the old session and issues new tokens for a new session', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });

    const result = await env.service.refresh(token, client);

    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(900);
    expect(result.refreshToken).not.toBe(token);
    expect(env.sessions).toHaveLength(2);
    expect(env.sessions.find((s) => s.id === 'old')?.revokedAt).toBeInstanceOf(Date);

    const fresh = env.sessions[1] as SessionRow;
    expect(fresh.revokedAt).toBeNull();
    expect(fresh.userId).toBe(USER);

    const payload = await env.jwt.verifyAsync<{ sub: string; sid: string }>(result.accessToken);
    expect(payload.sub).toBe(USER);
    expect(payload.sid).toBe(fresh.id);
  });

  it('keeps the device info and gives the new session a fresh 30-day lifetime', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({
      id: 'old',
      token,
      deviceName: 'Pixel 8',
      platform: 'android',
      expiresAt: new Date(Date.now() + 2 * DAY),
    });

    const result = await env.service.refresh(token, client);
    const fresh = env.sessions[1] as SessionRow;

    expect(fresh.deviceName).toBe('Pixel 8');
    expect(fresh.platform).toBe('android');
    expect(fresh.ip).toBe('5.6.7.8');
    const expected = Date.now() + 30 * DAY;
    expect(Math.abs(new Date(result.refreshExpiresAt).getTime() - expected)).toBeLessThan(5000);
    expect(Math.abs(fresh.expiresAt.getTime() - expected)).toBeLessThan(5000);
  });

  it('lets the new refresh token be used for the next refresh', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });

    const first = await env.service.refresh(token, client);
    const second = await env.service.refresh(first.refreshToken, client);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(env.sessions).toHaveLength(3);
  });

  it('stores only the hash of the new refresh token', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });

    const result = await env.service.refresh(token, client);
    const fresh = env.sessions[1] as SessionRow;

    expect(fresh.refreshTokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(fresh.refreshTokenHash).not.toBe(result.refreshToken);
  });
});

describe('RefreshService.refresh: invalid tokens', () => {
  it('rejects a malformed token without a database lookup', async () => {
    const env = makeEnv();
    const spy = vi.spyOn(env.db.session, 'findUnique');
    expect(await reject(env.service.refresh('not-a-token', client))).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_INVALID',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    const env = makeEnv();
    expect(await reject(env.service.refresh(generateRefreshToken(), client))).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_INVALID',
    });
  });

  it('rejects an expired session without rotating it', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token, expiresAt: new Date(Date.now() - 1000) });

    expect(await reject(env.service.refresh(token, client))).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_EXPIRED',
    });
    expect(env.sessions).toHaveLength(1);
    expect(env.sessions[0]?.revokedAt).toBeNull();
  });

  it('refuses a suspended user and does not rotate', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });
    env.users.set(USER, { id: USER, status: 'SUSPENDED' });

    expect(await reject(env.service.refresh(token, client))).toEqual({
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
    expect(env.sessions).toHaveLength(1);
    expect(env.sessions[0]?.revokedAt).toBeNull();
  });

  it('refuses a deleted user', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });
    env.users.set(USER, { id: USER, status: 'DELETED' });

    expect(await reject(env.service.refresh(token, client))).toEqual({
      status: 403,
      code: 'ACCOUNT_DELETED',
    });
  });
});

describe('RefreshService.refresh: reuse detection', () => {
  it('treats reuse of a rotated token as theft: revokes all sessions and writes an audit entry', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });
    env.seed({ id: 'other-device', token: generateRefreshToken() });

    await env.service.refresh(token, client); // legitimate use
    const reuse = await reject(env.service.refresh(token, client)); // the same token again

    expect(reuse).toEqual({ status: 401, code: 'REFRESH_TOKEN_REUSED' });
    expect(env.sessions.filter((s) => s.userId === USER).every((s) => s.revokedAt !== null)).toBe(
      true,
    );
    expect(env.audits).toHaveLength(1);
    expect(env.audits[0]).toMatchObject({
      actorId: USER,
      action: 'auth.refresh_reuse_detected',
      entityType: 'session',
      entityId: 'old',
      ip: '5.6.7.8',
      metadata: { revokedSessions: 2 }, // the other device + the freshly rotated session
    });
  });

  it('only revokes the sessions of the affected user', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });
    env.seed({ id: 'bobs-phone', userId: BOB, token: generateRefreshToken() });

    await env.service.refresh(token, client);
    await reject(env.service.refresh(token, client));

    expect(env.sessions.find((s) => s.id === 'bobs-phone')?.revokedAt).toBeNull();
  });

  it('does not raise an alarm for a revoked token that has also expired', async () => {
    const env = makeEnv();
    const staleToken = generateRefreshToken();
    env.seed({
      id: 'stale',
      token: staleToken,
      revokedAt: new Date(Date.now() - 40 * DAY),
      expiresAt: new Date(Date.now() - 10 * DAY),
    });
    env.seed({ id: 'active', token: generateRefreshToken() });

    expect(await reject(env.service.refresh(staleToken, client))).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_INVALID',
    });
    expect(env.audits).toHaveLength(0);
    expect(env.sessions.find((s) => s.id === 'active')?.revokedAt).toBeNull();
  });

  it('treats losing a rotation race as reuse', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });

    // Simulate another request revoking the session between our check and our update.
    const real = env.db.session.updateMany;
    env.db.session.updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockImplementation(real) as never;

    expect(await reject(env.service.refresh(token, client))).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_REUSED',
    });
    expect(env.sessions).toHaveLength(1); // no new session was created
    expect(env.audits).toHaveLength(1);
  });

  it('still answers REFRESH_TOKEN_REUSED when the audit write fails', async () => {
    const env = makeEnv();
    const token = generateRefreshToken();
    env.seed({ id: 'old', token });
    await env.service.refresh(token, client);

    env.db.auditLog.create.mockRejectedValueOnce(new Error('db down'));
    expect(await reject(env.service.refresh(token, client))).toEqual({
      status: 401,
      code: 'REFRESH_TOKEN_REUSED',
    });
    expect(env.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });
});