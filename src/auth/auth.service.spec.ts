import { HttpException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { hashRefreshToken } from './token.crypto.js';

const PHONE = '+919876543210';
const SECRET = 's'.repeat(32);
const client = { ip: '1.2.3.4', userAgent: 'TestAgent/1.0' };

interface UserRow {
  id: string;
  phone: string;
  phoneVerifiedAt: Date | null;
  status: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  profileCompletedAt: Date | null;
}

function setup(existing?: Partial<UserRow>, otpError?: Error) {
  const users: UserRow[] = existing
    ? [
        {
          id: 'user0',
          phone: PHONE,
          phoneVerifiedAt: new Date('2026-01-01T00:00:00Z'),
          status: 'ACTIVE',
          username: null,
          name: null,
          avatarUrl: null,
          profileCompletedAt: null,
          ...existing,
        },
      ]
    : [];
  const consents: Array<Record<string, unknown>> = [];
  const sessions: Array<Record<string, unknown>> = [];

  const db = {
    user: {
      findUnique: async ({ where }: { where: { phone: string } }) =>
        users.find((u) => u.phone === where.phone) ?? null,
      create: async ({ data }: { data: { phone: string; phoneVerifiedAt: Date } }) => {
        const row: UserRow = {
          id: `user${users.length + 1}`,
          status: 'ACTIVE',
          username: null,
          name: null,
          avatarUrl: null,
          profileCompletedAt: null,
          ...data,
        };
        users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = users.find((u) => u.id === where.id) as UserRow;
        Object.assign(row, data);
        return row;
      },
    },
    consentRecord: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        consents.push(...data);
        return { count: data.length };
      },
    },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `sess${sessions.length + 1}`, ...data };
        sessions.push(row);
        return row;
      },
    },
  };
  const prisma = { ...db, $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };

  const otp = {
    verifyOtp: vi.fn(async (_phone: string, _code: string): Promise<void> => {
      if (otpError) throw otpError;
    }),
  };
  const values: Record<string, unknown> = { JWT_ACCESS_TTL_SECONDS: 900, REFRESH_TTL_DAYS: 30 };
  const config = { get: (key: string) => values[key] };
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } });
  const links = {
    linkByPhone: vi.fn(async (_userId: string, _phone: string, _ip?: string) => ({
      linked: [],
      conflicts: [],
    })),
  };
  const service = new AuthService(
    prisma as never,
    config as never,
    otp as never,
    jwt,
    links as never,
  );
  return { service, users, consents, sessions, otp, jwt, links };
}

const codeOf = (e: unknown): string | undefined =>
  ((e as HttpException).getResponse() as { code?: string }).code;

describe('AuthService.verifyOtpAndSignIn', () => {
  it('creates a new user with consent records and a session, and issues tokens', async () => {
    const { service, users, consents, sessions, otp, jwt } = setup();
    const result = await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);

    expect(otp.verifyOtp).toHaveBeenCalledWith(PHONE, '123456');
    expect(result.isNewUser).toBe(true);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(900);
    expect(result.user.profileCompleted).toBe(false);

    expect(users).toHaveLength(1);
    expect(users[0]?.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(consents.map((c) => c.type)).toEqual(['TERMS', 'PRIVACY']);
    expect(consents.every((c) => c.version === '2026-11-04')).toBe(true);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.refreshTokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(sessions[0]?.refreshTokenHash).not.toBe(result.refreshToken);
    expect(sessions[0]?.ip).toBe('1.2.3.4');

    const payload = await jwt.verifyAsync<{ sub: string; sid: string; iat: number; exp: number }>(
      result.accessToken,
    );
    expect(payload.sub).toBe(users[0]?.id);
    expect(payload.sid).toBe('sess1');
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('links invited memberships for the verified phone after signing in a new user', async () => {
    const { service, links, users } = setup();
    await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);
    expect(links.linkByPhone).toHaveBeenCalledTimes(1);
    expect(links.linkByPhone).toHaveBeenCalledWith(users[0]?.id, PHONE, '1.2.3.4');
  });

  it('also links for an existing user, because invitations can arrive after sign-up', async () => {
    const { service, links } = setup({});
    await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);
    expect(links.linkByPhone).toHaveBeenCalledWith('user0', PHONE, '1.2.3.4');
  });

  it('still signs the user in when linking fails, and logs only the masked phone', async () => {
    const { service, links, sessions } = setup();
    links.linkByPhone.mockRejectedValueOnce(new Error('db down'));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const result = await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(sessions).toHaveLength(1);
    const message = String(logged.mock.calls[0]?.[0]);
    expect(message).toContain('+91******3210');
    expect(message).not.toContain(PHONE);
    logged.mockRestore();
  });

  it('does not link for a suspended account', async () => {
    const { service, links } = setup({ status: 'SUSPENDED' });
    await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client).catch(() => undefined);
    expect(links.linkByPhone).not.toHaveBeenCalled();
  });

  it('does not link when the OTP check fails', async () => {
    const { service, links } = setup(undefined, new Error('bad code'));
    await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client).catch(() => undefined);
    expect(links.linkByPhone).not.toHaveBeenCalled();
  });

  it('signs in an existing user without creating a user or consent records', async () => {
    const { service, users, consents, sessions } = setup({});
    const result = await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);
    expect(result.isNewUser).toBe(false);
    expect(users).toHaveLength(1);
    expect(consents).toHaveLength(0);
    expect(sessions).toHaveLength(1);
  });

  it('marks the phone as verified for an existing user that was not yet verified', async () => {
    const { service, users } = setup({ phoneVerifiedAt: null });
    await service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);
    expect(users[0]?.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it('refuses a suspended account and creates no session', async () => {
    const { service, sessions } = setup({ status: 'SUSPENDED' });
    const error = await service
      .verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client)
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('ACCOUNT_SUSPENDED');
    expect(sessions).toHaveLength(0);
  });

  it('refuses a deleted account', async () => {
    const { service } = setup({ status: 'DELETED' });
    const error = await service
      .verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client)
      .catch((e: unknown) => e);
    expect(codeOf(error)).toBe('ACCOUNT_DELETED');
  });

  it('writes nothing when the OTP check fails', async () => {
    const { service, users, sessions } = setup(undefined, new Error('bad code'));
    await expect(
      service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client),
    ).rejects.toThrow('bad code');
    expect(users).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('stores device info, falling back to the User-Agent for the device name', async () => {
    const withDevice = setup();
    await withDevice.service.verifyOtpAndSignIn(
      { phone: PHONE, code: '123456', device: { name: 'Pixel 8', platform: 'android' } },
      client,
    );
    expect(withDevice.sessions[0]?.deviceName).toBe('Pixel 8');
    expect(withDevice.sessions[0]?.platform).toBe('android');

    const withoutDevice = setup();
    await withoutDevice.service.verifyOtpAndSignIn({ phone: PHONE, code: '123456' }, client);
    expect(withoutDevice.sessions[0]?.deviceName).toBe('TestAgent/1.0');
    expect(withoutDevice.sessions[0]?.platform).toBeNull();
  });
});