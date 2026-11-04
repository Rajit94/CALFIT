import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  isWellFormedRefreshToken,
} from './token.crypto.js';

describe('generateRefreshToken', () => {
  it('produces 43-character base64url tokens', () => {
    expect(generateRefreshToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces unique tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateRefreshToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('hashRefreshToken', () => {
  it('is deterministic and 64 hex characters long', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different hashes for different tokens', () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(
      hashRefreshToken(generateRefreshToken()),
    );
  });

  it('does not contain the token itself', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).not.toContain(token);
  });
});

describe('isWellFormedRefreshToken', () => {
  it('accepts generated tokens', () => {
    expect(isWellFormedRefreshToken(generateRefreshToken())).toBe(true);
  });

  it('rejects tokens with the wrong length or characters', () => {
    const bad = [
      '',
      'short',
      'a'.repeat(42),
      'a'.repeat(44),
      'a'.repeat(42) + '=',
      'a'.repeat(42) + '+',
      'a'.repeat(42) + '/',
      'a'.repeat(42) + ' ',
    ];
    for (const value of bad) {
      expect(isWellFormedRefreshToken(value)).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    for (const value of [undefined, null, 123, {}, ['x']]) {
      expect(isWellFormedRefreshToken(value)).toBe(false);
    }
  });
});