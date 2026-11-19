const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MAX_AGE_YEARS = 100;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

// The parts of a REAL calendar date written as YYYY-MM-DD, or null.
export function parseIsoDate(value: string): DateParts | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  const real =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  return real ? { year, month, day } : null;
}

// Today's calendar date in India (IST), as YYYY-MM-DD.
export function istDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

// Whole years between two YYYY-MM-DD dates. A 29 February birthday counts from 1 March in other years.
export function ageInYears(dob: string, today: string): number {
  const b = parseIsoDate(dob);
  const t = parseIsoDate(today);
  if (!b || !t) throw new Error('Invalid date');
  let age = t.year - b.year;
  if (t.month < b.month || (t.month === b.month && t.day < b.day)) age -= 1;
  return age;
}

// users.dateOfBirth is a @db.Date column: a Date at UTC midnight.
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
export function fromDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export type DobCheck =
  | { ok: true; age: number }
  | { ok: false; reason: 'INVALID' | 'FUTURE' | 'TOO_OLD' | 'TOO_YOUNG' };

export function checkDateOfBirth(dob: string, today: string, minAge: number): DobCheck {
  if (parseIsoDate(dob) === null) return { ok: false, reason: 'INVALID' };
  if (dob > today) return { ok: false, reason: 'FUTURE' };
  const age = ageInYears(dob, today);
  if (age > MAX_AGE_YEARS) return { ok: false, reason: 'TOO_OLD' };
  if (age < minAge) return { ok: false, reason: 'TOO_YOUNG' };
  return { ok: true, age };
}