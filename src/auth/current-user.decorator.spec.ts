import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { requireAuthUser } from './current-user.decorator.js';

describe('requireAuthUser', () => {
  it('returns the user that the guard attached', () => {
    const user = { id: 'user-1', sessionId: 'session-1' };
    expect(requireAuthUser({ user })).toBe(user);
  });

  it('answers 401 TOKEN_MISSING when no user is attached', () => {
    expect(() => requireAuthUser({})).toThrow(UnauthorizedException);
    try {
      requireAuthUser({});
    } catch (error) {
      const body = (error as UnauthorizedException).getResponse() as { code?: string };
      expect(body.code).toBe('TOKEN_MISSING');
    }
  });
});