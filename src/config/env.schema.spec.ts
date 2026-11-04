import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

describe('envSchema', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/calfit',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    OTP_PEPPER: 'b'.repeat(32),
  };

  it('applies defaults', () => {
    const env = envSchema.parse(base);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT to a number', () => {
    expect(envSchema.parse({ ...base, PORT: '4000' }).PORT).toBe(4000);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(envSchema.safeParse({ ...base, DATABASE_URL: 'mysql://x/y' }).success).toBe(false);
  });

  it('requires a JWT secret of at least 32 characters', () => {
    expect(envSchema.safeParse({ ...base, JWT_ACCESS_SECRET: 'short' }).success).toBe(false);
    const { JWT_ACCESS_SECRET: _omit, ...rest } = base;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it('requires an OTP pepper of at least 32 characters', () => {
    expect(envSchema.safeParse({ ...base, OTP_PEPPER: 'short' }).success).toBe(false);
    const { OTP_PEPPER: _omit, ...rest } = base;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it('applies the auth and OTP defaults', () => {
    const env = envSchema.parse(base);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TTL_DAYS).toBe(30);
    expect(env.OTP_TTL_SECONDS).toBe(300);
    expect(env.OTP_MAX_ATTEMPTS).toBe(5);
    expect(env.OTP_RESEND_COOLDOWN_SECONDS).toBe(30);
    expect(env.OTP_MAX_SENDS_PER_PHONE_PER_HOUR).toBe(5);
    expect(env.OTP_MAX_SENDS_PER_IP_PER_HOUR).toBe(20);
    expect(env.OTP_PROVIDER).toBe('console');
  });

  it('rejects the dev OTP code in production', () => {
    const result = envSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      OTP_DEV_FIXED_CODE: '123456',
    });
    expect(result.success).toBe(false);
  });

  it('allows the dev OTP code in development', () => {
    const result = envSchema.safeParse({
      ...base,
      NODE_ENV: 'development',
      OTP_DEV_FIXED_CODE: '123456',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed dev OTP code', () => {
    expect(envSchema.safeParse({ ...base, OTP_DEV_FIXED_CODE: '12345' }).success).toBe(false);
  });
});