import { describe, expect, it } from 'vitest';
import {
  GYM_CODE_ALPHABET,
  GYM_CODE_LENGTH,
  generateGymCode,
  generateQrSecret,
  isValidGymCode,
  normalizeGymCode,
} from './gym-code.js';

describe('gym codes', () => {
  it('uses an alphabet without ambiguous characters', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) expect(GYM_CODE_ALPHABET).not.toContain(bad);
    expect(new Set(GYM_CODE_ALPHABET).size).toBe(GYM_CODE_ALPHABET.length);
  });

  it('generates valid 6-character codes that are almost always different', () => {
    const codes = Array.from({ length: 1000 }, () => generateGymCode());
    expect(codes.every((c) => c.length === GYM_CODE_LENGTH && isValidGymCode(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(990);
  });

  it('builds the code from the supplied randomness', () => {
    expect(generateGymCode(() => 0)).toBe('AAAAAA');
    expect(generateGymCode((max) => max - 1)).toBe('999999'.replace(/9/g, '9'));
  });

  it('normalises case, spaces and hyphens', () => {
    expect(normalizeGymCode(' k7m-2qx ')).toBe('K7M2QX');
    expect(normalizeGymCode('k7m 2qx')).toBe('K7M2QX');
  });

  it('validates the format', () => {
    expect(isValidGymCode('K7M2QX')).toBe(true);
    for (const bad of ['', 'K7M2Q', 'K7M2QXX', 'K7M2Q0', 'K7M2QO', 'k7m2qx', 'K7M-2QX']) {
      expect(isValidGymCode(bad)).toBe(false);
    }
  });

  it('generates a long random QR secret', () => {
    const a = generateQrSecret();
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(generateQrSecret()).not.toBe(a);
  });
});