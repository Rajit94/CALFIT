import { randomBytes, randomInt } from 'node:crypto';

// No 0/O, 1/I or L, so codes are easy to read and type.
export const GYM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GYM_CODE_LENGTH = 6;

const VALID_CODE = new RegExp(`^[${GYM_CODE_ALPHABET}]{${GYM_CODE_LENGTH}}$`);

export function generateGymCode(
  randomIndex: (max: number) => number = (max) => randomInt(0, max),
): string {
  let code = '';
  for (let i = 0; i < GYM_CODE_LENGTH; i++) {
    code += GYM_CODE_ALPHABET.charAt(randomIndex(GYM_CODE_ALPHABET.length));
  }
  return code;
}

// Accepts "k7m-2qx", " K7M 2QX " and similar.
export function normalizeGymCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function isValidGymCode(code: string): boolean {
  return VALID_CODE.test(code);
}

// Secret for the daily check-in QR (used by the check-in module). Never returned by any endpoint.
export function generateQrSecret(): string {
  return randomBytes(32).toString('base64url');
}