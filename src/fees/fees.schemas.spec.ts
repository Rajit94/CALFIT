import { describe, expect, it } from 'vitest';
import {
  acceptInvitationSchema,
  assignFeeSchema,
  createPlanSchema,
  listFeesQuerySchema,
  listPlansQuerySchema,
  reasonBodySchema,
  recordPaymentSchema,
  rupeesSchema,
  updatePlanSchema,
} from './fees.schemas.js';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';

describe('rupeesSchema', () => {
  it('turns rupees into paise', () => {
    expect(rupeesSchema.parse(500)).toBe(50000);
    expect(rupeesSchema.parse(499.5)).toBe(49950);
    expect(rupeesSchema.parse(1)).toBe(100);
    expect(rupeesSchema.parse(1_000_000)).toBe(100_000_000);
  });

  it.each([0, 0.5, -10, 1_000_000.01, 10.555, 'abc', '500', null])('rejects %j', (value) => {
    expect(rupeesSchema.safeParse(value).success).toBe(false);
  });
});

describe('plan schemas', () => {
  const valid = { name: 'Monthly', durationDays: 30, price: 500 };

  it('accepts a plan and converts the price', () => {
    const parsed = createPlanSchema.parse({ ...valid, description: '' });
    expect(parsed).toMatchObject({ name: 'Monthly', durationDays: 30, price: 50000, description: null });
  });

  it.each([{ durationDays: 0 }, { durationDays: 366 }, { durationDays: 1.5 }, { price: 0 }, { name: 'A' }])(
    'rejects %j',
    (over) => {
      expect(createPlanSchema.safeParse({ ...valid, ...over }).success).toBe(false);
    },
  );

  it('accepts a one-day and a 365-day plan', () => {
    expect(createPlanSchema.safeParse({ ...valid, durationDays: 1 }).success).toBe(true);
    expect(createPlanSchema.safeParse({ ...valid, durationDays: 365 }).success).toBe(true);
  });

  it('updates one field, but not an empty update or unknown fields', () => {
    expect(updatePlanSchema.parse({ price: 450 }).price).toBe(45000);
    expect(updatePlanSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updatePlanSchema.safeParse({}).success).toBe(false);
    expect(updatePlanSchema.safeParse({ gymId: 'x' }).success).toBe(false);
  });

  it('reads includeInactive from the query, defaulting to false', () => {
    expect(listPlansQuerySchema.parse({}).includeInactive).toBe(false);
    expect(listPlansQuerySchema.parse({ includeInactive: 'true' }).includeInactive).toBe(true);
    expect(listPlansQuerySchema.safeParse({ includeInactive: 'yes' }).success).toBe(false);
  });
});

describe('assignFeeSchema', () => {
  it('accepts the minimum and the full form', () => {
    expect(assignFeeSchema.safeParse({ planId: PLAN_ID, startDate: '2026-11-04' }).success).toBe(true);
    const full = assignFeeSchema.parse({
      planId: PLAN_ID, startDate: '2026-11-04', dueDate: '2026-11-10', amount: 400, amountReason: 'Student discount',
    });
    expect(full).toMatchObject({ dueDate: '2026-11-10', amount: 40000, amountReason: 'Student discount' });
  });

  it('rejects a bad plan id, bad dates and a too-short reason', () => {
    expect(assignFeeSchema.safeParse({ planId: 'x', startDate: '2026-11-04' }).success).toBe(false);
    expect(assignFeeSchema.safeParse({ planId: PLAN_ID, startDate: '2026-02-30' }).success).toBe(false);
    expect(assignFeeSchema.safeParse({ planId: PLAN_ID, startDate: '2026-11-04', dueDate: 'soon' }).success).toBe(false);
    expect(assignFeeSchema.safeParse({ planId: PLAN_ID, startDate: '2026-11-04', amount: 400, amountReason: 'no' }).success).toBe(false);
  });
});

describe('recordPaymentSchema', () => {
  it('accepts every method and converts the amount', () => {
    for (const method of ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER']) {
      expect(recordPaymentSchema.safeParse({ amount: 200, method }).success).toBe(true);
    }
    expect(recordPaymentSchema.parse({ amount: 200, method: 'UPI' }).amount).toBe(20000);
    expect(recordPaymentSchema.safeParse({ amount: 200, method: 'BITCOIN' }).success).toBe(false);
  });

  it('parses paidAt as a date or a date-time with a time zone', () => {
    const date = recordPaymentSchema.parse({ amount: 200, method: 'CASH', paidAt: '2026-11-01' });
    expect(date.paidAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    const zoned = recordPaymentSchema.parse({ amount: 200, method: 'CASH', paidAt: '2026-11-01T10:30:00+05:30' });
    expect(zoned.paidAt?.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    for (const bad of ['01/11/2026', '2026-02-30', '2026-11-01T10:30:00', 'yesterday']) {
      expect(recordPaymentSchema.safeParse({ amount: 200, method: 'CASH', paidAt: bad }).success).toBe(false);
    }
  });

  it('clears an empty note and limits long ones', () => {
    expect(recordPaymentSchema.parse({ amount: 200, method: 'CASH', note: '  ' }).note).toBeNull();
    expect(recordPaymentSchema.safeParse({ amount: 200, method: 'CASH', note: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('reason, invitation and list schemas', () => {
  it('requires a reason of at least 3 characters', () => {
    expect(reasonBodySchema.parse({ reason: ' Wrong amount ' }).reason).toBe('Wrong amount');
    expect(reasonBodySchema.safeParse({ reason: 'no' }).success).toBe(false);
    expect(reasonBodySchema.safeParse({}).success).toBe(false);
  });

  it('needs an explicit WhatsApp answer to accept an invitation', () => {
    expect(acceptInvitationSchema.safeParse({ whatsappConsent: false }).success).toBe(true);
    expect(acceptInvitationSchema.safeParse({}).success).toBe(false);
  });

  it('validates the fee list query', () => {
    expect(listFeesQuerySchema.parse({}).limit).toBe(50);
    expect(listFeesQuerySchema.parse({ status: 'overdue' }).status).toBe('OVERDUE');
    expect(listFeesQuerySchema.safeParse({ status: 'GONE' }).success).toBe(false);
    expect(listFeesQuerySchema.safeParse({ memberId: 'nope' }).success).toBe(false);
    expect(listFeesQuerySchema.safeParse({ cursor: 'nope' }).success).toBe(false);
    expect(listFeesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listFeesQuerySchema.safeParse({ dueFrom: '2026-12-01', dueTo: '2026-11-01' }).success).toBe(false);
    expect(listFeesQuerySchema.safeParse({ dueFrom: '2026-11-01', dueTo: '2026-12-01' }).success).toBe(true);
  });
});