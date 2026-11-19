import { z } from 'zod';
import { otpCodeSchema, phoneSchema } from '../auth/validation.js';
import { parseIsoDate } from '../common/profile/age.js';

// Blocked so usernames cannot collide with routes or impersonate the product.
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'about', 'admin', 'administrator', 'api', 'calfit', 'contact', 'explore', 'feed', 'gym', 'gyms',
  'help', 'login', 'logout', 'me', 'messages', 'moderator', 'mod', 'notifications', 'official', 'owner',
  'privacy', 'profile', 'register', 'root', 'search', 'security', 'settings', 'signup', 'staff',
  'support', 'system', 'terms', 'trainer', 'user', 'users',
]);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username can be at most 30 characters')
  .regex(/^[a-z0-9_.]+$/, 'Use only letters, numbers, underscores and dots')
  .refine((v) => !v.startsWith('.') && !v.endsWith('.'), 'Username cannot start or end with a dot')
  .refine((v) => !v.includes('..'), 'Username cannot contain two dots in a row')
  .refine((v) => !RESERVED_USERNAMES.has(v), 'This username is not available');

export const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(60, 'Name can be at most 60 characters')
  .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), 'Name contains invalid characters')
  .transform((v) => v.replace(/\s+/g, ' '));

// An empty string clears the bio (stored as null).
export const bioSchema = z
  .string()
  .trim()
  .max(150, 'Bio can be at most 150 characters')
  .refine((v) => !/[\u0000-\u0009\u000B-\u001F\u007F]/.test(v), 'Bio contains invalid characters')
  .transform((v) => (v === '' ? null : v));

export const dateOfBirthSchema = z
  .string()
  .trim()
  .refine((v) => parseIsoDate(v) !== null, 'Use the format YYYY-MM-DD with a real calendar date');

export const setupProfileSchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  dateOfBirth: dateOfBirthSchema,
  bio: bioSchema.optional(),
});
export type SetupProfileDto = z.infer<typeof setupProfileSchema>;

// Strict on purpose: sending dateOfBirth (or any unknown field) here is an error, not silently ignored.
export const updateProfileSchema = z
  .strictObject({
    name: nameSchema.optional(),
    username: usernameSchema.optional(),
    bio: bioSchema.optional(),
    privacy: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

export const guardianSchema = z.object({
  guardianName: nameSchema,
  guardianPhone: phoneSchema,
});
export type GuardianDto = z.infer<typeof guardianSchema>;

export const guardianVerifySchema = z.object({ code: otpCodeSchema });
export type GuardianVerifyDto = z.infer<typeof guardianVerifySchema>;