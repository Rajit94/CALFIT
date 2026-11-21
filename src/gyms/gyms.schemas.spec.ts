import { describe, expect, it } from 'vitest';
import {
  addHolidaySchema,
  createGymSchema,
  gymCodeSchema,
  holidayRangeSchema,
  joinGymSchema,
  joinRequestsQuerySchema,
  timingsSchema,
  updateGymSchema,
} from './gyms.schemas.js';

const valid = { name: "Gold's Gym", city: 'Jabalpur', latitude: 23.1815, longitude: 79.9864 };

describe('createGymSchema', () => {
  it('accepts the required fields and tidies text', () => {
    const parsed = createGymSchema.parse({ ...valid, name: '  Gold   Gym ', description: '', pincode: '482001' });
    expect(parsed.name).toBe('Gold Gym');
    expect(parsed.description).toBeNull();
    expect(parsed.pincode).toBe('482001');
  });

  it('requires name, city, latitude and longitude', () => {
    for (const key of ['name', 'city', 'latitude', 'longitude'] as const) {
      const { [key]: _omit, ...rest } = valid;
      expect(createGymSchema.safeParse(rest).success).toBe(false);
    }
  });

  it.each([
    { latitude: 91 },
    { latitude: -91 },
    { longitude: 181 },
    { latitude: 0, longitude: 0 },
    { checkInRadiusM: 49 },
    { checkInRadiusM: 501 },
    { checkInRadiusM: 150.5 },
    { name: 'A' },
    { pincode: '12345' },
    { city: 'X' },
  ])('rejects %j', (over) => {
    expect(createGymSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });

  it('accepts a radius at both ends and a valid schedule', () => {
    expect(createGymSchema.safeParse({ ...valid, checkInRadiusM: 50 }).success).toBe(true);
    expect(createGymSchema.safeParse({ ...valid, checkInRadiusM: 500 }).success).toBe(true);
    expect(createGymSchema.safeParse({ ...valid, timings: { mon: [['06:00', '10:00'], ['17:00', '22:00']] } }).success).toBe(true);
  });
});

describe('timingsSchema', () => {
  it('accepts an empty schedule, which clears it', () => {
    expect(timingsSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    { mon: [['10:00', '06:00']] },
    { mon: [['06:00', '06:00']] },
    { mon: [['06:00', '10:00'], ['09:00', '12:00']] },
    { mon: [['6:00', '10:00']] },
    { mon: [['06:00', '24:00']] },
    { mon: [['00:00', '01:00'], ['02:00', '03:00'], ['04:00', '05:00'], ['06:00', '07:00'], ['08:00', '09:00']] },
    { funday: [['06:00', '10:00']] },
  ])('rejects %j', (value) => {
    expect(timingsSchema.safeParse(value).success).toBe(false);
  });

  it('accepts periods that touch but do not overlap', () => {
    expect(timingsSchema.safeParse({ tue: [['06:00', '10:00'], ['10:00', '12:00']] }).success).toBe(true);
  });
});

describe('updateGymSchema', () => {
  it('accepts a single field and clears optional text with an empty string', () => {
    expect(updateGymSchema.safeParse({ name: 'New Name' }).success).toBe(true);
    expect(updateGymSchema.parse({ description: '' }).description).toBeNull();
  });

  it('rejects an empty update', () => {
    expect(updateGymSchema.safeParse({}).success).toBe(false);
  });

  it('rejects fields that cannot be changed here', () => {
    for (const bad of [{ code: 'ABCDEF' }, { status: 'SUSPENDED' }, { isVerified: true }, { qrSecret: 'x' }]) {
      expect(updateGymSchema.safeParse({ name: 'Fine Name', ...bad }).success).toBe(false);
    }
  });

  it('needs latitude and longitude together, and refuses 0,0', () => {
    expect(updateGymSchema.safeParse({ latitude: 10 }).success).toBe(false);
    expect(updateGymSchema.safeParse({ longitude: 10 }).success).toBe(false);
    expect(updateGymSchema.safeParse({ latitude: 10, longitude: 20 }).success).toBe(true);
    expect(updateGymSchema.safeParse({ latitude: 0, longitude: 0 }).success).toBe(false);
  });
});

describe('gym code and join schemas', () => {
  it('normalises codes', () => {
    expect(gymCodeSchema.parse(' k7m-2qx ')).toBe('K7M2QX');
    expect(gymCodeSchema.safeParse('K7M2Q').success).toBe(false);
    expect(gymCodeSchema.safeParse(undefined).success).toBe(false);
  });

  it('requires an explicit WhatsApp consent answer', () => {
    expect(joinGymSchema.parse({ code: 'k7m2qx', whatsappConsent: false })).toEqual({ code: 'K7M2QX', whatsappConsent: false });
    expect(joinGymSchema.safeParse({ code: 'K7M2QX' }).success).toBe(false);
    expect(joinGymSchema.safeParse({ code: 'K7M2QX', whatsappConsent: 'yes' }).success).toBe(false);
  });
});

describe('holiday and pagination schemas', () => {
  it('validates holiday dates and clears an empty reason', () => {
    expect(addHolidaySchema.parse({ date: '2026-11-14', reason: ' ' }).reason).toBeNull();
    expect(addHolidaySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
    expect(addHolidaySchema.safeParse({}).success).toBe(false);
  });

  it('validates the holiday range query', () => {
    expect(holidayRangeSchema.safeParse({}).success).toBe(true);
    expect(holidayRangeSchema.safeParse({ from: '2026-11-01', to: '2026-12-31' }).success).toBe(true);
    expect(holidayRangeSchema.safeParse({ from: 'soon' }).success).toBe(false);
  });

  it('defaults and bounds the page size', () => {
    expect(joinRequestsQuerySchema.parse({}).limit).toBe(50);
    expect(joinRequestsQuerySchema.parse({ limit: '20' }).limit).toBe(20);
    expect(joinRequestsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(joinRequestsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(joinRequestsQuerySchema.safeParse({ cursor: 'not-a-uuid' }).success).toBe(false);
  });
});