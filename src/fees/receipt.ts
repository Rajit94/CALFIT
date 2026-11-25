export type ReceiptPrefix = 'R' | 'X'; // R = payment receipt, X = reversal entry

export const RECEIPT_DIGITS = 6;

export function formatReceiptNo(prefix: ReceiptPrefix, n: number): string {
  return `${prefix}-${String(n).padStart(RECEIPT_DIGITS, '0')}`;
}

// The next number in a gym's sequence, given the highest existing receipt number with this prefix.
// Numbers are zero-padded, so they sort correctly as text up to 999,999 per gym and prefix.
export function nextReceiptNo(prefix: ReceiptPrefix, last: string | null): string {
  if (last === null) return formatReceiptNo(prefix, 1);
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(last);
  if (!match?.[1]) throw new Error(`Unexpected receipt number: ${last}`);
  return formatReceiptNo(prefix, Number(match[1]) + 1);
}

export function isReversalReceipt(receiptNo: string): boolean {
  return receiptNo.startsWith('X-');
}

// There is no column linking a reversal to its original, so the original receipt number is written
// at the start of the note. The "reversed" state of a payment is derived from this.
export function buildReversalNote(originalReceiptNo: string, reason: string): string {
  return `REVERSAL OF ${originalReceiptNo}: ${reason}`;
}

export function parseReversalTarget(note: string | null): string | null {
  const match = /^REVERSAL OF (R-\d{6,}): /.exec(note ?? '');
  return match?.[1] ?? null;
}