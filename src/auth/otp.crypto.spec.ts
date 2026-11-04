import { describe, expect, it, vi } from 'vitest';
import { generateOtpCode, hashOtp, verifyOtp } from './otp.crypto.js';

const pepper = 'p'.repeat(32);
const phone = '+919876543210';

describe('generateOtpCode', () => {
  it('always returns exactly six digits', () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('pads with leading zeros', () => {
    expect(generateOtpCode(() => 42)).toBe('000042');
  });

  it('asks for a number in the range 0 to 999999', () => {
    const random = vi.fn((_min: number, _max: number) => 7);
    generateOtpCode(random);
    expect(random).toHaveBeenCalledWith(0, 1_000_000);
  });
});

describe('hashOtp', () => {
  it('is deterministic and 64 hex characters long', () => {
    const a = hashOtp(pepper, phone, '123456');
    expect(a).toBe(hashOtp(pepper, phone, '123456'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the phone, code or pepper changes', () => {
    const base = hashOtp(pepper, phone, '123456');
    expect(hashOtp(pepper, '+919876543211', '123456')).not.toBe(base);
    expect(hashOtp(pepper, phone, '123457')).not.toBe(base);
    expect(hashOtp('q'.repeat(32), phone, '123456')).not.toBe(base);
  });
});

describe('verifyOtp', () => {
  const stored = hashOtp(pepper, phone, '123456');

  it('accepts the correct code', () => {
    expect(verifyOtp(pepper, phone, '123456', stored)).toBe(true);
  });

  it('rejects a wrong code', () => {
    expect(verifyOtp(pepper, phone, '654321', stored)).toBe(false);
  });

  it('rejects the right code for a different phone', () => {
    expect(verifyOtp(pepper, '+919876543211', '123456', stored)).toBe(false);
  });

  it('rejects a different pepper', () => {
    expect(verifyOtp('q'.repeat(32), phone, '123456', stored)).toBe(false);
  });

  it('rejects malformed, empty or truncated stored hashes', () => {
    for (const bad of ['', 'not-hex', 'abcd', stored.slice(0, -2)]) {
      expect(verifyOtp(pepper, phone, '123456', bad)).toBe(false);
    }
  });

  it('rejects codes that are not exactly six digits', () => {
    expect(verifyOtp(pepper, phone, '12345', hashOtp(pepper, phone, '12345'))).toBe(false);
    expect(verifyOtp(pepper, phone, '1234567', hashOtp(pepper, phone, '1234567'))).toBe(false);
  });
});