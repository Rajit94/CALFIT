import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

type RandomInt = (min: number, max: number) => number;

// Uniformly random 6-digit code (no modulo bias), zero-padded: 42 -> "000042".
export function generateOtpCode(random: RandomInt = (min, max) => randomInt(min, max)): string {
  return random(0, 1_000_000).toString().padStart(6, '0');
}

// HMAC-SHA256 keyed with the server-side pepper. The phone is part of the input,
// so a stored hash cannot be replayed for a different number.
export function hashOtp(pepper: string, phone: string, code: string): string {
  return createHmac('sha256', pepper).update(`otp:${phone}:${code}`).digest('hex');
}

// Constant-time comparison against the stored hash.
export function verifyOtp(
  pepper: string,
  phone: string,
  code: string,
  expectedHash: string,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const actual = Buffer.from(hashOtp(pepper, phone, code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}