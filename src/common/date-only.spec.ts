import { describe, expect, it } from 'vitest';
import { addDays } from './date-only.js';

describe('addDays', () => {
  it('moves across month and year boundaries', () => {
    expect(addDays('2026-11-04', 1)).toBe('2026-11-05');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-04', 365)).toBe('2027-11-04');
  });

  it('handles leap years and negative offsets', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-11-04', -4)).toBe('2026-10-31');
  });

  it('throws for an invalid date', () => {
    expect(() => addDays('nope', 1)).toThrow();
  });
});