import { describe, expect, it } from 'vitest';
import { readNumber, readSecret } from './auth-config.js';

const make = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never;

describe('readNumber', () => {
  it('returns numeric values', () => {
    expect(readNumber(make({ OTP_TTL_SECONDS: 300 }), 'OTP_TTL_SECONDS')).toBe(300);
  });

  it('converts numeric strings', () => {
    expect(readNumber(make({ OTP_TTL_SECONDS: '300' }), 'OTP_TTL_SECONDS')).toBe(300);
  });

  it('throws for missing, empty or non-numeric values', () => {
    for (const value of [undefined, '', 'abc', null, Number.NaN]) {
      expect(() => readNumber(make({ OTP_TTL_SECONDS: value }), 'OTP_TTL_SECONDS')).toThrow(
        'OTP_TTL_SECONDS',
      );
    }
  });
});

describe('readSecret', () => {
  it('returns long secrets and rejects short or missing ones', () => {
    expect(readSecret(make({ OTP_PEPPER: 'x'.repeat(32) }), 'OTP_PEPPER')).toBe('x'.repeat(32));
    expect(() => readSecret(make({ OTP_PEPPER: 'short' }), 'OTP_PEPPER')).toThrow('OTP_PEPPER');
    expect(() => readSecret(make({}), 'OTP_PEPPER')).toThrow('OTP_PEPPER');
  });
});