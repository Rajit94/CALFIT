import { HttpException, Logger } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashOtp } from './otp.crypto.js';
import { OtpService } from './otp.service.js';

const PEPPER = 'p'.repeat(32);
const PHONE = '+919876543210';
const T0 = new Date('2026-11-04T10:00:00.000Z');

interface Row {
  id: string;
  phone: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  ip: string | null;
  createdAt: Date;
}

// A small in-memory stand-in for the otp_requests table.
function makePrisma() {
  const rows: Row[] = [];
  let seq = 0;
  const prisma = {
    otpRequest: {
      findFirst: async ({ where }: { where: { phone: string } }) =>
        rows
          .filter((r) => r.phone === where.phone)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      count: async ({
        where,
      }: {
        where: { phone?: string; ip?: string; createdAt: { gte: Date } };
      }) =>
        rows.filter(
          (r) =>
            (where.phone === undefined || r.phone === where.phone) &&
            (where.ip === undefined || r.ip === where.ip) &&
            r.createdAt.getTime() >= where.createdAt.gte.getTime(),
        ).length,
      create: async ({
        data,
      }: {
        data: { phone: string; codeHash: string; expiresAt: Date; ip: string | null };
      }) => {
        const row: Row = {
          id: `row${++seq}`,
          attempts: 0,
          consumedAt: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; consumedAt?: null; attempts?: { lt: number } };
        data: { attempts?: { increment: number }; consumedAt?: Date };
      }) => {
        const hit = rows.filter(
          (r) =>
            r.id === where.id &&
            (where.consumedAt === undefined || r.consumedAt === null) &&
            (where.attempts === undefined || r.attempts < where.attempts.lt),
        );
        for (const r of hit) {
          if (data.attempts) r.attempts += data.attempts.increment;
          if (data.consumedAt) r.consumedAt = data.consumedAt;
        }
        return { count: hit.length };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i >= 0) rows.splice(i, 1);
        return {};
      },
    },
  };
  return { prisma, rows };
}

function setup(overrides: Record<string, unknown> = {}) {
  const { prisma, rows } = makePrisma();
  const values: Record<string, unknown> = {
    OTP_PEPPER: PEPPER,
    OTP_TTL_SECONDS: 300,
    OTP_MAX_ATTEMPTS: 5,
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    OTP_MAX_SENDS_PER_PHONE_PER_HOUR: 5,
    OTP_MAX_SENDS_PER_IP_PER_HOUR: 20,
    OTP_DEV_FIXED_CODE: undefined,
    ...overrides,
  };
  const config = { get: (key: string) => values[key] };
  const sender = { send: vi.fn(async (_phone: string, _code: string): Promise<void> => undefined) };
  const service = new OtpService(prisma as never, config as never, sender as never);
  return { service, rows, sender };
}

const lastCode = (sender: { send: { mock: { calls: string[][] } } }): string =>
  sender.send.mock.calls.at(-1)?.[1] as string;

async function caught(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('Expected the promise to reject');
}
const codeOf = (e: HttpException): string | undefined =>
  (e.getResponse() as { code?: string }).code;

const advance = (seconds: number): void => {
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
};

beforeAll(() => {
  Logger.overrideLogger(false);
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OtpService.requestOtp', () => {
  it('stores a hashed code, sends the plain code once, and returns the timings', async () => {
    const { service, rows, sender } = setup();
    const result = await service.requestOtp(PHONE, '1.2.3.4');
    expect(result).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 30 });
    expect(sender.send).toHaveBeenCalledTimes(1);
    const code = lastCode(sender);
    expect(code).toMatch(/^\d{6}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).toBe(hashOtp(PEPPER, PHONE, code));
    expect(Object.values(rows[0] as Row)).not.toContain(code);
    expect(rows[0]?.expiresAt.toISOString()).toBe('2026-11-04T10:05:00.000Z');
    expect(rows[0]?.ip).toBe('1.2.3.4');
  });

  it('uses the fixed dev code when configured', async () => {
    const { service, rows, sender } = setup({ OTP_DEV_FIXED_CODE: '123456' });
    await service.requestOtp(PHONE, undefined);
    expect(lastCode(sender)).toBe('123456');
    expect(rows[0]?.codeHash).toBe(hashOtp(PEPPER, PHONE, '123456'));
  });

  it('rejects a second request inside the resend cooldown', async () => {
    const { service, sender } = setup();
    await service.requestOtp(PHONE, undefined);
    advance(10);
    const error = await caught(service.requestOtp(PHONE, undefined));
    expect(error.getStatus()).toBe(429);
    expect(codeOf(error)).toBe('OTP_RESEND_TOO_SOON');
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('allows a new request after the cooldown', async () => {
    const { service, rows } = setup();
    await service.requestOtp(PHONE, undefined);
    advance(31);
    await service.requestOtp(PHONE, undefined);
    expect(rows).toHaveLength(2);
  });

  it('enforces the hourly per-phone limit', async () => {
    const { service } = setup({
      OTP_RESEND_COOLDOWN_SECONDS: 0,
      OTP_MAX_SENDS_PER_PHONE_PER_HOUR: 3,
    });
    for (let i = 0; i < 3; i++) await service.requestOtp(PHONE, undefined);
    const error = await caught(service.requestOtp(PHONE, undefined));
    expect(codeOf(error)).toBe('OTP_PHONE_LIMIT_REACHED');
    advance(3601);
    await expect(service.requestOtp(PHONE, undefined)).resolves.toBeDefined();
  });

  it('enforces the hourly per-IP limit across different phones', async () => {
    const { service } = setup({
      OTP_RESEND_COOLDOWN_SECONDS: 0,
      OTP_MAX_SENDS_PER_IP_PER_HOUR: 2,
    });
    await service.requestOtp('+919876543210', '9.9.9.9');
    await service.requestOtp('+919876543211', '9.9.9.9');
    const error = await caught(service.requestOtp('+919876543212', '9.9.9.9'));
    expect(codeOf(error)).toBe('OTP_IP_LIMIT_REACHED');
  });

  it('removes the record and returns 503 when sending fails', async () => {
    const { service, rows, sender } = setup();
    sender.send.mockRejectedValueOnce(new Error('sms down'));
    const error = await caught(service.requestOtp(PHONE, undefined));
    expect(error.getStatus()).toBe(503);
    expect(codeOf(error)).toBe('OTP_SEND_FAILED');
    expect(rows).toHaveLength(0);
  });
});

describe('OtpService.verifyOtp', () => {
  it('accepts the correct code and consumes it', async () => {
    const { service, rows, sender } = setup();
    await service.requestOtp(PHONE, undefined);
    await expect(service.verifyOtp(PHONE, lastCode(sender))).resolves.toBeUndefined();
    expect(rows[0]?.consumedAt).not.toBeNull();
  });

  it('rejects reuse of an already consumed code', async () => {
    const { service, sender } = setup();
    await service.requestOtp(PHONE, undefined);
    const code = lastCode(sender);
    await service.verifyOtp(PHONE, code);
    const error = await caught(service.verifyOtp(PHONE, code));
    expect(codeOf(error)).toBe('OTP_EXPIRED');
  });

  it('rejects a wrong code, counts the attempt, and still accepts the right one', async () => {
    const { service, rows, sender } = setup();
    await service.requestOtp(PHONE, undefined);
    const code = lastCode(sender);
    const wrong = code === '000000' ? '000001' : '000000';
    const error = await caught(service.verifyOtp(PHONE, wrong));
    expect(error.getStatus()).toBe(400);
    expect(codeOf(error)).toBe('OTP_INVALID');
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.consumedAt).toBeNull();
    await expect(service.verifyOtp(PHONE, code)).resolves.toBeUndefined();
  });

  it('locks the code after the maximum attempts, even for the right code', async () => {
    const { service, sender } = setup({ OTP_MAX_ATTEMPTS: 3 });
    await service.requestOtp(PHONE, undefined);
    const code = lastCode(sender);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i++) {
      expect(codeOf(await caught(service.verifyOtp(PHONE, wrong)))).toBe('OTP_INVALID');
    }
    const error = await caught(service.verifyOtp(PHONE, code));
    expect(error.getStatus()).toBe(429);
    expect(codeOf(error)).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('rejects an expired code', async () => {
    const { service, sender } = setup();
    await service.requestOtp(PHONE, undefined);
    advance(301);
    const error = await caught(service.verifyOtp(PHONE, lastCode(sender)));
    expect(codeOf(error)).toBe('OTP_EXPIRED');
  });

  it('only accepts the latest code', async () => {
    const { service, sender } = setup();
    await service.requestOtp(PHONE, undefined);
    const first = lastCode(sender);
    advance(31);
    await service.requestOtp(PHONE, undefined);
    const second = lastCode(sender);
    if (first !== second) {
      expect(codeOf(await caught(service.verifyOtp(PHONE, first)))).toBe('OTP_INVALID');
    }
    await expect(service.verifyOtp(PHONE, second)).resolves.toBeUndefined();
  });

  it('rejects verification when no code was requested', async () => {
    const { service } = setup();
    const error = await caught(service.verifyOtp(PHONE, '123456'));
    expect(codeOf(error)).toBe('OTP_EXPIRED');
  });
});