// Money is handled as whole paise (integers) inside the code, so there are no floating-point errors.
// Requests and responses use rupees with at most 2 decimals.
export const MIN_AMOUNT_PAISE = 100; // Rs 1
export const MAX_AMOUNT_PAISE = 100_000_000; // Rs 10,00,000

// Accepts numbers, numeric strings and Prisma Decimal values.
export function toPaise(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error('Not a valid amount');
  return Math.round(n * 100);
}

export function fromPaise(paise: number): number {
  return paise / 100;
}

export function isWholePaise(rupees: number): boolean {
  return Number.isFinite(rupees) && Math.abs(rupees * 100 - Math.round(rupees * 100)) < 1e-6;
}

export function formatRupees(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}