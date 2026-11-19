import { describe, expect, it } from 'vitest';
import {
  bioSchema,
  dateOfBirthSchema,
  guardianSchema,
  guardianVerifySchema,
  nameSchema,
  setupProfileSchema,
  updateProfileSchema,
  usernameSchema,
} from './users.schemas.js';

describe('usernameSchema', () => {
  it.each(['rajit', 'rajit_k', 'rajit.k', 'user123', 'a_b', '123'])('accepts %j', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(true);
  });

  it('trims and lowercases', () => {
    expect(usernameSchema.parse('  ABC.Def ')).toBe('abc.def');
  });

  it.each([
    'ab',
    'a'.repeat(31),
    'has space',
    'bad-char!',
    '.leading',
    'trailing.',
    'double..dot',
    'admin',
    'Admin',
    'calfit',
    '',
  ])('rejects %j', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });
});

describe('nameSchema', () => {
  it('trims and collapses whitespace', () => {
    expect(nameSchema.parse('  Rajit   Kumar ')).toBe('Rajit Kumar');
  });

  it('accepts names in other scripts', () => {
    expect(nameSchema.safeParse('राजीत कुमार').success).toBe(true);
  });

  it('rejects too short, too long and control characters', () => {
    expect(nameSchema.safeParse('A').success).toBe(false);
    expect(nameSchema.safeParse('a'.repeat(61)).success).toBe(false);
    expect(nameSchema.safeParse('Bad\u0000Name').success).toBe(false);
  });
});

describe('bioSchema', () => {
  it('turns an empty bio into null and keeps text', () => {
    expect(bioSchema.parse('   ')).toBeNull();
    expect(bioSchema.parse(' Lifting daily ')).toBe('Lifting daily');
  });

  it('allows line breaks but not other control characters, and caps the length', () => {
    expect(bioSchema.safeParse('line one\nline two').success).toBe(true);
    expect(bioSchema.safeParse('bad\u0007bell').success).toBe(false);
    expect(bioSchema.safeParse('x'.repeat(151)).success).toBe(false);
  });
});

describe('dateOfBirthSchema', () => {
  it('accepts a real date and rejects impossible or badly formatted ones', () => {
    expect(dateOfBirthSchema.safeParse('1995-05-20').success).toBe(true);
    expect(dateOfBirthSchema.safeParse('1995-02-30').success).toBe(false);
    expect(dateOfBirthSchema.safeParse('20/05/1995').success).toBe(false);
    expect(dateOfBirthSchema.safeParse('').success).toBe(false);
  });
});

describe('setupProfileSchema', () => {
  const valid = { name: 'Rajit Kumar', username: 'rajit.k', dateOfBirth: '1995-05-20' };

  it('accepts the required fields, with or without a bio', () => {
    expect(setupProfileSchema.safeParse(valid).success).toBe(true);
    expect(setupProfileSchema.safeParse({ ...valid, bio: 'Hi' }).success).toBe(true);
  });

  it('requires name, username and dateOfBirth', () => {
    for (const key of ['name', 'username', 'dateOfBirth'] as const) {
      const { [key]: _omit, ...rest } = valid;
      expect(setupProfileSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('strips unknown fields such as privacy', () => {
    const parsed = setupProfileSchema.parse({ ...valid, privacy: 'PUBLIC' });
    expect('privacy' in parsed).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  it('accepts any single field', () => {
    expect(updateProfileSchema.safeParse({ name: 'New Name' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ privacy: 'PRIVATE' }).success).toBe(true);
    expect(updateProfileSchema.parse({ bio: '' }).bio).toBeNull();
  });

  it('rejects an empty update', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown fields, including dateOfBirth', () => {
    expect(updateProfileSchema.safeParse({ dateOfBirth: '1990-01-01' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ name: 'Ok Name', isAdmin: true }).success).toBe(false);
  });

  it('rejects an invalid privacy value', () => {
    expect(updateProfileSchema.safeParse({ privacy: 'FRIENDS' }).success).toBe(false);
  });
});

describe('guardian schemas', () => {
  it('accepts a guardian name and an E.164 phone number', () => {
    expect(guardianSchema.safeParse({ guardianName: 'Asha Kumar', guardianPhone: '+919876543299' }).success).toBe(true);
  });

  it('rejects a bad phone number or a missing name', () => {
    expect(guardianSchema.safeParse({ guardianName: 'Asha Kumar', guardianPhone: '9876543299' }).success).toBe(false);
    expect(guardianSchema.safeParse({ guardianPhone: '+919876543299' }).success).toBe(false);
  });

  it('accepts only a six-digit code for verification', () => {
    expect(guardianVerifySchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(guardianVerifySchema.safeParse({ code: '12345' }).success).toBe(false);
  });
});