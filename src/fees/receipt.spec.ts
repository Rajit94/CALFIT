import { describe, expect, it } from 'vitest';
import {
  buildReversalNote,
  formatReceiptNo,
  isReversalReceipt,
  nextReceiptNo,
  parseReversalTarget,
} from './receipt.js';

describe('receipt numbers', () => {
  it('formats with six digits', () => {
    expect(formatReceiptNo('R', 1)).toBe('R-000001');
    expect(formatReceiptNo('X', 123456)).toBe('X-123456');
  });

  it('starts at 1 and continues the sequence', () => {
    expect(nextReceiptNo('R', null)).toBe('R-000001');
    expect(nextReceiptNo('R', 'R-000009')).toBe('R-000010');
    expect(nextReceiptNo('X', 'X-000001')).toBe('X-000002');
  });

  it('refuses a number that does not belong to the sequence', () => {
    expect(() => nextReceiptNo('R', 'X-000001')).toThrow();
    expect(() => nextReceiptNo('R', 'garbage')).toThrow();
  });

  it('recognises reversal receipts by their prefix', () => {
    expect(isReversalReceipt('X-000001')).toBe(true);
    expect(isReversalReceipt('R-000001')).toBe(false);
  });
});

describe('reversal notes', () => {
  it('round-trips the original receipt number', () => {
    const note = buildReversalNote('R-000002', 'Entered the wrong amount');
    expect(note).toBe('REVERSAL OF R-000002: Entered the wrong amount');
    expect(parseReversalTarget(note)).toBe('R-000002');
  });

  it('returns null for ordinary notes, empty notes and look-alikes', () => {
    expect(parseReversalTarget(null)).toBeNull();
    expect(parseReversalTarget('')).toBeNull();
    expect(parseReversalTarget('Paid at the desk')).toBeNull();
    expect(parseReversalTarget('reversal of R-000002: lowercase')).toBeNull();
    expect(parseReversalTarget('REVERSAL OF X-000001: wrong prefix')).toBeNull();
  });
});