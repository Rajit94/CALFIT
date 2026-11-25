import { describe, expect, it } from 'vitest';
import { toFeeDetail, toFeeItem, toMyFeeItem, toPaymentItems } from './fee-view.js';
import type { FeeDetailRowInput, FeeRowInput, PaymentRowInput } from './fee-view.js';

const TODAY = '2026-11-04';
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const fee = (over: Partial<FeeRowInput> = {}): FeeRowInput => ({
  id: 'fee-1',
  gymMemberId: 'member-1',
  status: 'PENDING',
  periodStart: d('2026-11-04'),
  periodEnd: d('2026-12-03'),
  dueDate: d('2026-11-10'),
  amount: 500,
  amountPaid: 0,
  paidAt: null,
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  plan: { id: 'plan-1', name: 'Monthly' },
  gymMember: {
    status: 'ACTIVE',
    invitedName: null,
    invitedPhone: null,
    user: { name: 'Asha Rao', phone: '+919876543210' },
  },
  ...over,
});

const payment = (over: Partial<PaymentRowInput> = {}): PaymentRowInput => ({
  id: 'p1',
  receiptNo: 'R-000001',
  amount: 200,
  method: 'CASH',
  paidAt: new Date('2026-11-04T10:00:00.000Z'),
  note: null,
  recordedById: 'owner',
  ...over,
});

describe('toFeeItem', () => {
  it('maps amounts, dates, plan and member for an unpaid fee', () => {
    expect(toFeeItem(fee(), TODAY)).toEqual({
      feeId: 'fee-1',
      memberId: 'member-1',
      member: { name: 'Asha Rao', phone: '+919876543210', phoneMasked: '+91******3210', status: 'ACTIVE' },
      plan: { planId: 'plan-1', name: 'Monthly' },
      periodStart: '2026-11-04',
      periodEnd: '2026-12-03',
      dueDate: '2026-11-10',
      amount: 500,
      amountPaid: 0,
      balance: 500,
      waivedAmount: 0,
      status: 'PENDING',
      paidAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('works out PARTIAL, OVERDUE and PAID', () => {
    expect(toFeeItem(fee({ amountPaid: 200, status: 'PARTIAL' }), TODAY)).toMatchObject({ status: 'PARTIAL', balance: 300 });
    expect(toFeeItem(fee({ dueDate: d('2026-10-20') }), TODAY)).toMatchObject({ status: 'OVERDUE', balance: 500 });
    expect(
      toFeeItem(fee({ status: 'PAID', amountPaid: 500, paidAt: new Date('2026-11-03T00:00:00.000Z') }), TODAY),
    ).toMatchObject({ status: 'PAID', balance: 0, paidAt: '2026-11-03T00:00:00.000Z' });
  });

  it('reports a waived fee with its waived amount and no balance', () => {
    expect(toFeeItem(fee({ status: 'WAIVED', amountPaid: 200 }), TODAY)).toMatchObject({
      status: 'WAIVED', balance: 0, waivedAmount: 300, amountPaid: 200,
    });
  });

  it('shows the full phone for active and invited members and only a masked one otherwise', () => {
    const invited = toFeeItem(
      fee({ gymMember: { status: 'INVITED', invitedName: 'Ravi', invitedPhone: '+919000000001', user: null } }),
      TODAY,
    );
    expect(invited.member).toEqual({ name: 'Ravi', phone: '+919000000001', phoneMasked: '+91******0001', status: 'INVITED' });

    const removed = toFeeItem(
      fee({ gymMember: { status: 'REMOVED', invitedName: null, invitedPhone: null, user: { name: 'Gary', phone: '+919876543210' } } }),
      TODAY,
    );
    expect(removed.member.phone).toBeNull();
    expect(removed.member.phoneMasked).toBe('+91******3210');
    expect(JSON.stringify(removed)).not.toContain('+919876543210');
  });

  it('handles a fee without a plan', () => {
    expect(toFeeItem(fee({ plan: null }), TODAY).plan).toBeNull();
  });
});

describe('toPaymentItems', () => {
  it('marks reversal entries and the payments they reverse', () => {
    const items = toPaymentItems([
      payment(),
      payment({ id: 'p2', receiptNo: 'R-000002', amount: 300 }),
      payment({ id: 'p3', receiptNo: 'X-000001', amount: -300, note: 'REVERSAL OF R-000002: wrong amount' }),
    ]);
    expect(items.map((i) => [i.receiptNo, i.kind, i.amount, i.reversed, i.reversesReceiptNo])).toEqual([
      ['R-000001', 'PAYMENT', 200, false, null],
      ['R-000002', 'PAYMENT', 300, true, null],
      ['X-000001', 'REVERSAL', -300, false, 'R-000002'],
    ]);
  });

  it('does not treat a note on an ordinary payment as a reversal', () => {
    const [item] = toPaymentItems([payment({ note: 'REVERSAL OF R-000009: sneaky' })]);
    expect(item).toMatchObject({ kind: 'PAYMENT', reversesReceiptNo: null, reversed: false });
  });
});

describe('detail and member views', () => {
  const detail: FeeDetailRowInput = { ...fee({ amountPaid: 200, status: 'PARTIAL' }), payments: [payment()] };

  it('toFeeDetail adds the payments', () => {
    expect(toFeeDetail(detail, TODAY).payments).toHaveLength(1);
  });

  it('toMyFeeItem leaves out the member details', () => {
    const mine = toMyFeeItem(detail, TODAY);
    expect(mine.payments).toHaveLength(1);
    expect('member' in mine).toBe(false);
    expect('memberId' in mine).toBe(false);
  });
});