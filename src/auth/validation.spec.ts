import { describe, expect, it } from 'vitest';
import { maskPhone, otpCodeSchema, phoneSchema } from './validation.js';

describe('phoneSchema', () => {
  it.each(['+919876543210', '+14155552671', '+447911123456', '+919000000000'])(
    'accepts %s',
    (value) => {
      expect(phoneSchema.safeParse(value).success).toBe(true);
    },
  );

  it('trims surrounding whitespace', () => {
    expect(phoneSchema.parse('  +919876543210 ')).toBe('+919876543210');
  });

  it.each([
    '9876543210',
    '+91 98765 43210',
    '+91abcdefghij',
    '+12345',
    '+1234567890123456',
    '+0123456789',
    '',
    '+911234567890',
    '+91987654321',
    '+9198765432100',
  ])('rejects %j', (value) => {
    expect(phoneSchema.safeParse(value).success).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(phoneSchema.safeParse(undefined).success).toBe(false);
    expect(phoneSchema.safeParse(null).success).toBe(false);
    expect(phoneSchema.safeParse(919876543210).success).toBe(false);
  });
});

describe('otpCodeSchema', () => {
  it('accepts six digits and trims whitespace', () => {
    expect(otpCodeSchema.parse('123456')).toBe('123456');
    expect(otpCodeSchema.parse(' 123456 ')).toBe('123456');
  });

  it.each(['12345', '1234567', 'abcdef', '12 3456', ''])('rejects %j', (value) => {
    expect(otpCodeSchema.safeParse(value).success).toBe(false);
  });
});

describe('maskPhone', () => {
  it('keeps the country prefix and last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });

  it('fully masks very short input', () => {
    expect(maskPhone('+12345')).toBe('******');
  });
});