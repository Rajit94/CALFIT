import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  checkDateOfBirth,
  fromDateOnly,
  istDateString,
  parseIsoDate,
  toDateOnly,
} from './age.js';

const TODAY = '2026-11-04';

describe('parseIsoDate', () => {
  it('accepts real calendar dates, including leap days', () => {
    expect(parseIsoDate('2026-11-04')).toEqual({ year: 2026, month: 11, day: 4 });
    expect(parseIsoDate('2008-02-29')).not.toBeNull();
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2027-02-29', '26-01-01', '2026-1-1', 'tomorrow', ''])(
    'rejects %j',
    (value) => {
      expect(parseIsoDate(value)).toBeNull();
    },
  );
});

describe('ageInYears', () => {
  it('counts completed years only', () => {
    expect(ageInYears('2008-11-05', TODAY)).toBe(17); // turns 18 tomorrow
    expect(ageInYears('2008-11-04', TODAY)).toBe(18); // turns 18 today
    expect(ageInYears('2008-11-03', TODAY)).toBe(18);
    expect(ageInYears('1995-05-20', TODAY)).toBe(31);
  });

  it('handles a 29 February birthday in a non-leap year', () => {
    expect(ageInYears('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageInYears('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('throws for invalid input', () => {
    expect(() => ageInYears('nope', TODAY)).toThrow();
  });
});

describe('istDateString', () => {
  it('uses the Indian calendar day, not UTC', () => {
    expect(istDateString(new Date('2026-11-04T10:00:00.000Z'))).toBe('2026-11-04');
    expect(istDateString(new Date('2026-11-04T19:00:00.000Z'))).toBe('2026-11-05');
    expect(istDateString(new Date('2026-11-04T18:29:59.000Z'))).toBe('2026-11-04');
  });
});

describe('toDateOnly / fromDateOnly', () => {
  it('round-trips a date without shifting the day', () => {
    expect(toDateOnly(fromDateOnly('2026-11-04'))).toBe('2026-11-04');
    expect(fromDateOnly('2026-11-04').toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });
});

describe('checkDateOfBirth', () => {
  it('accepts an adult and reports the age', () => {
    expect(checkDateOfBirth('1995-05-20', TODAY, 10)).toEqual({ ok: true, age: 31 });
  });

  it('accepts exactly the minimum age and exactly 100', () => {
    expect(checkDateOfBirth('2016-11-04', TODAY, 10)).toEqual({ ok: true, age: 10 });
    expect(checkDateOfBirth('1926-11-04', TODAY, 10)).toEqual({ ok: true, age: 100 });
  });

  it('rejects someone who turns the minimum age tomorrow', () => {
    expect(checkDateOfBirth('2016-11-05', TODAY, 10)).toEqual({ ok: false, reason: 'TOO_YOUNG' });
  });

  it('rejects ages above 100', () => {
    expect(checkDateOfBirth('1925-11-04', TODAY, 10)).toEqual({ ok: false, reason: 'TOO_OLD' });
  });

  it('rejects future and impossible dates', () => {
    expect(checkDateOfBirth('2027-01-01', TODAY, 10)).toEqual({ ok: false, reason: 'FUTURE' });
    expect(checkDateOfBirth('2001-02-30', TODAY, 10)).toEqual({ ok: false, reason: 'INVALID' });
  });
});