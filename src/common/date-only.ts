import { parseIsoDate } from './profile/age.js';

// Adds days to a YYYY-MM-DD date and returns YYYY-MM-DD. Pure calendar arithmetic, no time zones involved.
export function addDays(date: string, days: number): string {
  const parts = parseIsoDate(date);
  if (!parts) throw new Error('Invalid date');
  const result = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return result.toISOString().slice(0, 10);
}