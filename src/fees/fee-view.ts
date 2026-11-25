import { maskPhone } from '../auth/validation.js';
import { toDateOnly } from '../common/profile/age.js';
import { effectiveStatus } from './fee-status.js';
import type { EffectiveFeeStatus } from './fee-status.js';
import { fromPaise, toPaise } from './money.js';
import { isReversalReceipt, parseReversalTarget } from './receipt.js';

export interface PaymentRowInput {
  id: string;
  receiptNo: string;
  amount: unknown;
  method: string;
  paidAt: Date;
  note: string | null;
  recordedById: string;
}

export interface FeeRowInput {
  id: string;
  gymMemberId: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  amount: unknown;
  amountPaid: unknown;
  paidAt: Date | null;
  createdAt: Date;
  plan: { id: string; name: string } | null;
  gymMember: {
    status: string;
    invitedName: string | null;
    invitedPhone: string | null;
    user: { name: string | null; phone: string } | null;
  };
}

export type FeeDetailRowInput = FeeRowInput & { payments: PaymentRowInput[] };

export interface PaymentItem {
  paymentId: string;
  receiptNo: string;
  kind: 'PAYMENT' | 'REVERSAL';
  amount: number; // negative for reversals
  method: string;
  paidAt: string;
  note: string | null;
  reversesReceiptNo: string | null;
  reversed: boolean; // a payment that has been reversed
  recordedById: string;
}

export interface FeeCore {
  feeId: string;
  plan: { planId: string; name: string } | null;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amount: number;
  amountPaid: number;
  balance: number;
  waivedAmount: number;
  status: EffectiveFeeStatus;
  paidAt: string | null;
  createdAt: string;
}

export interface FeeMemberRef {
  name: string | null;
  phone: string | null; // full number only for ACTIVE and INVITED members, as in the member list
  phoneMasked: string | null;
  status: string;
}

export interface FeeItem extends FeeCore {
  memberId: string;
  member: FeeMemberRef;
}

export interface FeeDetail extends FeeItem {
  payments: PaymentItem[];
}

export interface MyFeeItem extends FeeCore {
  payments: PaymentItem[];
}

const FULL_PHONE_STATUSES = new Set(['ACTIVE', 'INVITED']);

export function toPaymentItems(rows: PaymentRowInput[]): PaymentItem[] {
  const reversedReceipts = new Set<string>();
  for (const row of rows) {
    if (!isReversalReceipt(row.receiptNo)) continue;
    const target = parseReversalTarget(row.note);
    if (target) reversedReceipts.add(target);
  }
  return rows.map((row) => {
    const reversal = isReversalReceipt(row.receiptNo);
    return {
      paymentId: row.id,
      receiptNo: row.receiptNo,
      kind: reversal ? 'REVERSAL' : 'PAYMENT',
      amount: fromPaise(toPaise(row.amount)),
      method: row.method,
      paidAt: row.paidAt.toISOString(),
      note: row.note,
      reversesReceiptNo: reversal ? parseReversalTarget(row.note) : null,
      reversed: !reversal && reversedReceipts.has(row.receiptNo),
      recordedById: row.recordedById,
    };
  });
}

export function toFeeCore(row: FeeRowInput, today: string): FeeCore {
  const amountPaise = toPaise(row.amount);
  const paidPaise = toPaise(row.amountPaid);
  const status = effectiveStatus(
    { status: row.status, amountPaise, paidPaise, dueDate: toDateOnly(row.dueDate) },
    today,
  );
  const open = Math.max(0, amountPaise - paidPaise);
  return {
    feeId: row.id,
    plan: row.plan ? { planId: row.plan.id, name: row.plan.name } : null,
    periodStart: toDateOnly(row.periodStart),
    periodEnd: toDateOnly(row.periodEnd),
    dueDate: toDateOnly(row.dueDate),
    amount: fromPaise(amountPaise),
    amountPaid: fromPaise(paidPaise),
    balance: fromPaise(status === 'WAIVED' ? 0 : open),
    waivedAmount: fromPaise(status === 'WAIVED' ? open : 0),
    status,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMemberRef(member: FeeRowInput['gymMember']): FeeMemberRef {
  const rawPhone = member.user?.phone ?? member.invitedPhone;
  return {
    name: member.user?.name ?? member.invitedName,
    phone: rawPhone && FULL_PHONE_STATUSES.has(member.status) ? rawPhone : null,
    phoneMasked: rawPhone ? maskPhone(rawPhone) : null,
    status: member.status,
  };
}

export function toFeeItem(row: FeeRowInput, today: string): FeeItem {
  return { ...toFeeCore(row, today), memberId: row.gymMemberId, member: toMemberRef(row.gymMember) };
}

export function toFeeDetail(row: FeeDetailRowInput, today: string): FeeDetail {
  return { ...toFeeItem(row, today), payments: toPaymentItems(row.payments) };
}

export function toMyFeeItem(row: FeeDetailRowInput, today: string): MyFeeItem {
  return { ...toFeeCore(row, today), payments: toPaymentItems(row.payments) };
}