import { describe, expect, it } from 'vitest';
import { requestOtpSchema, verifyOtpSchema } from './auth.schemas.js';

const valid = { phone: '+919876543210', code: '123456', acceptedTerms: true };

describe('requestOtpSchema', () => {
  it('accepts and trims a valid phone, and rejects an invalid one', () => {
    expect(requestOtpSchema.parse({ phone: ' +919876543210 ' }).phone).toBe('+919876543210');
    expect(requestOtpSchema.safeParse({ phone: '9876543210' }).success).toBe(false);
    expect(requestOtpSchema.safeParse({}).success).toBe(false);
  });
});

describe('verifyOtpSchema', () => {
  it('accepts a complete payload with device info', () => {
    const result = verifyOtpSchema.safeParse({
      ...valid,
      device: { name: 'Pixel 8', platform: 'android' },
    });
    expect(result.success).toBe(true);
  });

  it('requires acceptedTerms to be true', () => {
    expect(verifyOtpSchema.safeParse({ ...valid, acceptedTerms: false }).success).toBe(false);
    const { acceptedTerms: _omit, ...missing } = valid;
    expect(verifyOtpSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects an unknown device platform', () => {
    expect(
      verifyOtpSchema.safeParse({ ...valid, device: { platform: 'windows-phone' } }).success,
    ).toBe(false);
  });

  it('rejects a malformed code', () => {
    expect(verifyOtpSchema.safeParse({ ...valid, code: '12345' }).success).toBe(false);
  });

  it('strips unknown fields', () => {
    const parsed = verifyOtpSchema.parse({ ...valid, isAdmin: true });
    expect('isAdmin' in parsed).toBe(false);
  });
});