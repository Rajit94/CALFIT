import { describe, expect, it } from 'vitest';
import { refreshTokenSchema } from './session.schemas.js';

describe('refreshTokenSchema', () => {
  it('accepts a token string and trims it', () => {
    expect(refreshTokenSchema.parse({ refreshToken: ' abc ' }).refreshToken).toBe('abc');
  });

  it('rejects a missing, empty or non-string token', () => {
    expect(refreshTokenSchema.safeParse({}).success).toBe(false);
    expect(refreshTokenSchema.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(refreshTokenSchema.safeParse({ refreshToken: 123 }).success).toBe(false);
  });

  it('rejects an absurdly long token', () => {
    expect(refreshTokenSchema.safeParse({ refreshToken: 'a'.repeat(513) }).success).toBe(false);
  });
});