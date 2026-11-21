import { describe, expect, it } from 'vitest';
import { addCalendarMonths, trialDaysLeft } from './trial.js';

const at = (iso: string) => new Date(iso);

describe('addCalendarMonths', () => {
  it('adds two calendar months and keeps the time of day', () => {
    expect(addCalendarMonths(at('2026-11-04T10:15:30.500Z'), 2).toISOString()).toBe('2027-01-04T10:15:30.500Z');
  });

  it('clamps to the last day of a shorter month', () => {
    expect(addCalendarMonths(at('2026-12-31T00:00:00.000Z'), 2).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(addCalendarMonths(at('2027-12-31T00:00:00.000Z'), 2).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addCalendarMonths(at('2026-08-31T00:00:00.000Z'), 2).toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(addCalendarMonths(at('2026-01-31T00:00:00.000Z'), 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('rolls over the year', () => {
    expect(addCalendarMonths(at('2026-11-30T00:00:00.000Z'), 2).toISOString()).toBe('2027-01-30T00:00:00.000Z');
  });
});

describe('trialDaysLeft', () => {
  it('rounds partial days up and never goes below zero', () => {
    const now = at('2026-11-04T10:00:00.000Z');
    expect(trialDaysLeft(at('2027-01-04T10:00:00.000Z'), now)).toBe(61);
    expect(trialDaysLeft(at('2026-11-05T09:00:00.000Z'), now)).toBe(1);
    expect(trialDaysLeft(at('2026-11-04T10:00:00.000Z'), now)).toBe(0);
    expect(trialDaysLeft(at('2026-10-01T00:00:00.000Z'), now)).toBe(0);
  });
});