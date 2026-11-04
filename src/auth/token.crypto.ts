import { createHash, randomBytes } from 'node:crypto';

// 32 random bytes -> 43 base64url characters (no padding).
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

// Only this hash is stored in sessions.refreshTokenHash. A plain SHA-256 is enough
// because the token is high-entropy random data, unlike a short OTP code.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const REFRESH_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

// Cheap format check so garbage input is rejected before any database lookup.
export function isWellFormedRefreshToken(value: unknown): value is string {
  return typeof value === 'string' && REFRESH_TOKEN_FORMAT.test(value);
}