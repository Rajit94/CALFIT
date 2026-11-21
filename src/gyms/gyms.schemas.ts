import { z } from 'zod';
import { parseIsoDate } from '../common/profile/age.js';
import { isUuid } from '../common/uuid.js';
import { isValidGymCode, normalizeGymCode } from './gym-code.js';

const NO_CONTROL = /[\u0000-\u001F\u007F]/;
const NO_CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/;

const requiredText = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} can be at most ${max} characters`)
    .refine((v) => !NO_CONTROL.test(v), `${label} contains invalid characters`)
    .transform((v) => v.replace(/\s+/g, ' '));

// An empty string clears the field (stored as null).
const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} can be at most ${max} characters`)
    .refine((v) => !NO_CONTROL_EXCEPT_NEWLINE.test(v), `${label} contains invalid characters`)
    .transform((v) => (v === '' ? null : v));

const pincodeSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{6}$/.test(v), 'Pincode must be 6 digits')
  .transform((v) => (v === '' ? null : v));

const latitudeSchema = z.number().min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90');
const longitudeSchema = z.number().min(-180, 'Longitude must be between -180 and 180').max(180, 'Longitude must be between -180 and 180');
const radiusSchema = z.number().int().min(50, 'Check-in radius must be 50-500 metres').max(500, 'Check-in radius must be 50-500 metres');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour times like 06:30');

function validIntervals(list: Array<[string, string]>): boolean {
  const sorted = [...list].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.every(([start, end], i) => {
    const previous = sorted[i - 1];
    return start < end && (previous === undefined || previous[1] <= start);
  });
}

const dayIntervals = z
  .array(z.tuple([hhmm, hhmm]))
  .max(4, 'At most 4 opening periods per day')
  .refine(validIntervals, 'Each opening period must end after it starts, and periods must not overlap');

// {"mon": [["06:00","10:00"],["17:00","22:00"]], ...}. Send {} to clear the schedule.
export const timingsSchema = z.strictObject({
  mon: dayIntervals.optional(),
  tue: dayIntervals.optional(),
  wed: dayIntervals.optional(),
  thu: dayIntervals.optional(),
  fri: dayIntervals.optional(),
  sat: dayIntervals.optional(),
  sun: dayIntervals.optional(),
});

const notNullIsland = (v: { latitude?: number | undefined; longitude?: number | undefined }) =>
  !(v.latitude === 0 && v.longitude === 0);

export const createGymSchema = z
  .object({
    name: requiredText('Name', 2, 80),
    description: optionalText('Description', 500).optional(),
    address: optionalText('Address', 200).optional(),
    city: requiredText('City', 2, 60),
    state: optionalText('State', 60).optional(),
    pincode: pincodeSchema.optional(),
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    checkInRadiusM: radiusSchema.optional(),
    timings: timingsSchema.optional(),
  })
  .refine(notNullIsland, { message: 'Enter the real location of the gym', path: ['latitude'] });
export type CreateGymDto = z.infer<typeof createGymSchema>;

// Strict on purpose: code, status, isVerified and the subscription cannot be sent here.
export const updateGymSchema = z
  .strictObject({
    name: requiredText('Name', 2, 80).optional(),
    description: optionalText('Description', 500).optional(),
    address: optionalText('Address', 200).optional(),
    city: requiredText('City', 2, 60).optional(),
    state: optionalText('State', 60).optional(),
    pincode: pincodeSchema.optional(),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    checkInRadiusM: radiusSchema.optional(),
    timings: timingsSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update')
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'Send latitude and longitude together',
    path: ['latitude'],
  })
  .refine(notNullIsland, { message: 'Enter the real location of the gym', path: ['latitude'] });
export type UpdateGymDto = z.infer<typeof updateGymSchema>;

export const gymCodeSchema = z
  .string()
  .trim()
  .refine((v) => isValidGymCode(normalizeGymCode(v)), 'Enter the 6-character gym code')
  .transform(normalizeGymCode);

export const gymCodeQuerySchema = z.object({
  code: gymCodeSchema,
});

export const joinGymSchema = z.object({
  code: gymCodeSchema,
  // The answer is recorded; declining does not stop the person from joining.
  whatsappConsent: z.boolean(),
});
export type JoinGymDto = z.infer<typeof joinGymSchema>;

export const isoDateSchema = z
  .string()
  .trim()
  .refine((v) => parseIsoDate(v) !== null, 'Use the format YYYY-MM-DD with a real calendar date');

export const addHolidaySchema = z.object({
  date: isoDateSchema,
  reason: optionalText('Reason', 100).optional(),
});
export type AddHolidayDto = z.infer<typeof addHolidaySchema>;

export const holidayRangeSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const joinRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().refine(isUuid, 'Invalid cursor').optional(),
});