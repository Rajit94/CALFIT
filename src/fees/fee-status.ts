export const EFFECTIVE_FEE_STATUSES = ['PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED'] as const;
export type EffectiveFeeStatus = (typeof EFFECTIVE_FEE_STATUSES)[number];

export interface FeeStatusInput {
  status: string; // as stored
  amountPaise: number;
  paidPaise: number;
  dueDate: string; // YYYY-MM-DD
}

// OVERDUE is never stored by this module: it is worked out when a fee is read, from the due date (IST).
export function effectiveStatus(fee: FeeStatusInput, today: string): EffectiveFeeStatus {
  if (fee.status === 'WAIVED') return 'WAIVED';
  if (fee.paidPaise >= fee.amountPaise) return 'PAID';
  if (fee.dueDate < today) return 'OVERDUE';
  return fee.paidPaise > 0 ? 'PARTIAL' : 'PENDING';
}

// What is stored after a payment or a reversal.
export function storedStatusFor(amountPaise: number, paidPaise: number): 'PENDING' | 'PARTIAL' | 'PAID' {
  if (paidPaise >= amountPaise) return 'PAID';
  return paidPaise > 0 ? 'PARTIAL' : 'PENDING';
}

// Database filter for an effective status. Stored PENDING/PARTIAL/PAID/WAIVED are always kept in step with
// the amounts; a stored OVERDUE (which a future scheduled job may write) counts as unpaid with a past due date.
export function feeStatusWhere(status: EffectiveFeeStatus, today: Date): Record<string, unknown> {
  switch (status) {
    case 'PAID':
      return { status: 'PAID' };
    case 'WAIVED':
      return { status: 'WAIVED' };
    case 'PENDING':
      return { status: 'PENDING', dueDate: { gte: today } };
    case 'PARTIAL':
      return { status: 'PARTIAL', dueDate: { gte: today } };
    case 'OVERDUE':
      return { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: today } };
  }
}