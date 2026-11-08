import { HttpException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { beforeAll, describe, expect, it } from 'vitest';
import { LogoutService } from './logout.service.js';
import { RefreshService } from './refresh.service.js';
import { generateRefreshToken, hashRefreshToken } from './token.crypto.js';

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
}

// An in-memory stand-in for the sessions and audit_logs tables, shared by both services.
function makeEnv() {
  const sessions: SessionRow[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const db = {
    session: {
      findUnique: async ({ where }: { where: { refreshTokenHash: string } }) => {
        const s = sessions.find((x) => x.refreshTokenHash === where.refreshTokenHash);
        return s ? { ...s, user: { status: 'ACTIVE' } } : null;
      },
      findMany: async ({ where }: { where: { userId: string; revokedAt: null } }) =>
        sessions
          .filter((s) => s.userId === where.userId && s.revokedAt === null)
          .map((s) => ({ id: s.id })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; userId?: string; revokedAt: null };
        data: { revokedAt?: Date; refreshTokenHash?: string };
      }) => {
        const hit = sessions.filter(
          (s) =>
            (where.id === undefined || s.id === where.id) &&
            (where.userId === undefined || s.userId === where.userId) &&
            s.revokedAt === null,
        );
        for (const s of hit) {
          if (data.revokedAt) s.revokedAt = data.revokedAt;
          if (data.refreshTokenHash) s.refreshTokenHash = data.refreshTokenHash;
        }
        return { count: hit.length };
      },
      create: async ({ data }: { data: Omit<SessionRow, 'id' | 'revokedAt'> }) => {
        const row: SessionRow = { id: `new${sessions.length + 1}`, revokedAt: null, ...data };
        sessions.push(row);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };
  const prisma = { ...db, $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };

  const values: Record<string, unknown> = { JWT_ACCESS_TTL_SECONDS: 900, REFRESH_TTL_DAYS: 30 };
  const config = { get: (key: string) => values[key] };
  const jwt = new JwtService({ secret: 's'.repeat(32), signOptions: { algorithm: 'HS256' } });

  function seed(id: string, userId: string = USER): string {
    const token = generateRefreshToken();
    sessions.push({
      id,
      userId,
      refreshTokenHash: hashRefreshToken(token),
      deviceName: null,
      platform: null,
      ip: null,
      expiresAt: new Date(Date.now() + 10 * DAY),
      revokedAt: null,
    });
    return token;
  }

  return {
    sessions,
    audits,
    seed,
    logout: new LogoutService(prisma as never),
    refresh: new RefreshService(prisma as never, config as never, jwt),
  };
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

const INVALID = { status: 401, code: 'REFRESH_TOKEN_INVALID' };

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('LogoutService.logout', () => {
  it('revokes the session and scrambles its fingerprint', async () => {
    const env = makeEnv();
    const token = env.seed('s1');
    const before = hashRefreshToken(token);

    await env.logout.logout(token);

    const row = env.sessions[0] as SessionRow;
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.refreshTokenHash).not.toBe(before);
    expect(row.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers a logged-out token as invalid, not as theft, and raises no alarm', async () => {
    const env = makeEnv();
    const token = env.seed('s1');
    await env.logout.logout(token);

    expect(await reject(env.refresh.refresh(token, client))).toEqual(INVALID);
    expect(env.audits).toHaveLength(0);
  });

  it('leaves the same user’s other sessions and other users’ sessions untouched', async () => {
    const env = makeEnv();
    const token = env.seed('s1');
    env.seed('s2');
    env.seed('s3', BOB);

    await env.logout.logout(token);

    expect(env.sessions.find((s) => s.id === 's2')?.revokedAt).toBeNull();
    expect(env.sessions.find((s) => s.id === 's3')?.revokedAt).toBeNull();
  });

  it('stays silent for malformed, unknown and already-ended tokens, and changes nothing', async () => {
    const env = makeEnv();
    const ended = env.seed('s1');
    await env.logout.logout(ended);

    // A session revoked earlier (for example by reuse detection) keeps its fingerprint.
    const revokedEarlier = env.seed('s2');
    (env.sessions[1] as SessionRow).revokedAt = new Date(Date.now() - DAY);
    const snapshot = JSON.stringify(env.sessions);

    await expect(env.logout.logout('garbage')).resolves.toBeUndefined();
    await expect(env.logout.logout(generateRefreshToken())).resolves.toBeUndefined();
    await expect(env.logout.logout(ended)).resolves.toBeUndefined();
    await expect(env.logout.logout(revokedEarlier)).resolves.toBeUndefined();

    expect(JSON.stringify(env.sessions)).toBe(snapshot);
    expect((env.sessions[1] as SessionRow).refreshTokenHash).toBe(hashRefreshToken(revokedEarlier));
  });

  it('does not stop another device from refreshing', async () => {
    const env = makeEnv();
    const phone = env.seed('phone');
    const tablet = env.seed('tablet');

    await env.logout.logout(phone);

    await expect(env.refresh.refresh(tablet, client)).resolves.toMatchObject({
      tokenType: 'Bearer',
    });
  });
});

describe('LogoutService.logoutAll', () => {
  it('revokes every active session of the user and returns the count', async () => {
    const env = makeEnv();
    env.seed('a');
    env.seed('b');
    env.seed('c');

    const result = await env.logout.logoutAll(USER);

    expect(result).toEqual({ revokedSessions: 3 });
    expect(env.sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('leaves other users’ sessions alone', async () => {
    const env = makeEnv();
    env.seed('mine');
    env.seed('bobs', BOB);

    await env.logout.logoutAll(USER);

    expect(env.sessions.find((s) => s.id === 'bobs')?.revokedAt).toBeNull();
  });

  it('counts only sessions that were still active', async () => {
    const env = makeEnv();
    env.seed('a');
    env.seed('b');
    (env.sessions[1] as SessionRow).revokedAt = new Date(Date.now() - DAY);

    expect(await env.logout.logoutAll(USER)).toEqual({ revokedSessions: 1 });
  });

  it('gives every ended session a different scrambled fingerprint', async () => {
    const env = makeEnv();
    env.seed('a');
    env.seed('b');
    env.seed('c');
    const originals = env.sessions.map((s) => s.refreshTokenHash);

    await env.logout.logoutAll(USER);

    const after = env.sessions.map((s) => s.refreshTokenHash);
    expect(new Set(after).size).toBe(3);
    expect(after.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(after.some((h) => originals.includes(h))).toBe(false);
  });

  it('does not let stale tokens trigger a false alarm that kills a newer session', async () => {
    const env = makeEnv();
    const phone = env.seed('phone');
    const tablet = env.seed('tablet');

    await env.logout.logoutAll(USER);

    // The user signs in again on the phone: a brand-new session.
    const freshToken = env.seed('phone-new');

    // The old tablet wakes up and tries its stale token.
    expect(await reject(env.refresh.refresh(tablet, client))).toEqual(INVALID);
    expect(await reject(env.refresh.refresh(phone, client))).toEqual(INVALID);

    expect(env.audits).toHaveLength(0);
    expect(env.sessions.find((s) => s.id === 'phone-new')?.revokedAt).toBeNull();
    await expect(env.refresh.refresh(freshToken, client)).resolves.toBeDefined();
  });

  it('returns zero for a user with no sessions', async () => {
    const env = makeEnv();
    expect(await env.logout.logoutAll('nobody')).toEqual({ revokedSessions: 0 });
  });
});