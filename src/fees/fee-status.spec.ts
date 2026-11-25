import { describe, expect, it } from 'vitest';
import { effectiveStatus, feeStatusWhere, storedStatusFor } from './fee-status.js';

const TODAY = '2026-11-04';
const fee = (over: Partial<{ status: string; amountPaise: number; paidPaise: number; dueDate: string }> = {}) => ({
  status: 'PENDING',
  amountPaise: 50000,
  paidPaise: 0,
  dueDate: '2026-11-10',
  ...over,
});

describe('effectiveStatus', () => {
  it('is PENDING before the due date with nothing paid, and PARTIAL with something paid', () => {
    expect(effectiveStatus(fee(), TODAY)).toBe('PENDING');
    expect(effectiveStatus(fee({ paidPaise: 100 }), TODAY)).toBe('PARTIAL');
  });

  it('is not overdue on the due date itself, but is the day after', () => {
    expect(effectiveStatus(fee({ dueDate: TODAY }), TODAY)).toBe('PENDING');
    expect(effectiveStatus(fee({ dueDate: '2026-11-03' }), TODAY)).toBe('OVERDUE');
    expect(effectiveStatus(fee({ dueDate: '2026-11-03', paidPaise: 100 }), TODAY)).toBe('OVERDUE');
  });

  it('is PAID once fully paid, even after the due date', () => {
    expect(effectiveStatus(fee({ status: 'PAID', paidPaise: 50000, dueDate: '2026-10-01' }), TODAY)).toBe('PAID');
  });

  it('keeps WAIVED whatever the amounts and dates are', () => {
    expect(effectiveStatus(fee({ status: 'WAIVED', dueDate: '2026-01-01' }), TODAY)).toBe('WAIVED');
  });

  it('treats a stored OVERDUE as unpaid with a past due date', () => {
    expect(effectiveStatus(fee({ status: 'OVERDUE', dueDate: '2026-10-01' }), TODAY)).toBe('OVERDUE');
  });
});

describe('storedStatusFor', () => {
  it('follows the amounts', () => {
    expect(storedStatusFor(50000, 0)).toBe('PENDING');
    expect(storedStatusFor(50000, 100)).toBe('PARTIAL');
    expect(storedStatusFor(50000, 50000)).toBe('PAID');
  });
});

describe('feeStatusWhere', () => {
  const today = new Date('2026-11-04T00:00:00.000Z');

  it('maps each effective status to a database filter', () => {
    expect(feeStatusWhere('PAID', today)).toEqual({ status: 'PAID' });
    expect(feeStatusWhere('WAIVED', today)).toEqual({ status: 'WAIVED' });
    expect(feeStatusWhere('PENDING', today)).toEqual({ status: 'PENDING', dueDate: { gte: today } });
    expect(feeStatusWhere('PARTIAL', today)).toEqual({ status: 'PARTIAL', dueDate: { gte: today } });
    expect(feeStatusWhere('OVERDUE', today)).toEqual({
      status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
      dueDate: { lt: today },
    });
  });
});