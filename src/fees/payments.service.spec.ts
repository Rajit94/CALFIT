import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { FakeUniqueError, makeFeeDb } from '../../test/support/fake-fee-db.js';
import type { Row } from '../../test/support/fake-fee-db.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { PaymentsService } from './payments.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const DAY = 86_400_000;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function setup() {
  const db = makeFeeDb();
  const owner = db.seed.user();
  const gym = db.seed.gym({ code: 'K7M2QX', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  const plan = db.seed.plan({ gymId: gym.id });
  const member = db.seed.member({ gymId: gym.id, userId: db.seed.user().id, role: 'MEMBER', status: 'ACTIVE' });
  const service = new PaymentsService(db.prisma as never, new GymAccessService(db.prisma as never));

  const newFee = (over: Row = {}) =>
    db.seed.fee({ gymId: gym.id, gymMemberId: member.id, planId: plan.id, amount: 500, dueDate: d('2026-11-10'), ...over });
  const pay = (feeId: string, amountPaise: number, over: Row = {}) =>
    service.record(owner.id, gym.id, feeId, { amount: amountPaise, method: 'CASH', ...over } as never, '1.2.3.4');
  const reverse = (feeId: string, paymentId: string, reason = 'Entered the wrong amount') =>
    service.reverse(owner.id, gym.id, feeId, paymentId, reason, '1.2.3.4');
  return { db, owner, gym, sub, plan, member, service, newFee, pay, reverse };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PaymentsService.record', () => {
  it('records a partial payment: receipt R-000001, fee becomes PARTIAL with the balance reduced', async () => {
    const { db, gym, newFee, pay } = setup();
    const fee = newFee();
    const result = await pay(fee.id as string, 20000, { note: 'Paid at the desk' });

    expect(result.payment).toMatchObject({
      receiptNo: 'R-000001', kind: 'PAYMENT', amount: 200, method: 'CASH', note: 'Paid at the desk', reversed: false,
    });
    expect(result.fee).toMatchObject({ amountPaid: 200, balance: 300, status: 'PARTIAL', paidAt: null });
    expect(fee).toMatchObject({ amountPaid: 200, status: 'PARTIAL' });
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'fee.payment_recorded', gymId: gym.id, entityId: fee.id, metadata: { receiptNo: 'R-000001', amount: 200, method: 'CASH' }, ip: '1.2.3.4',
    });
  });

  it('completes the fee with the second payment: PAID, paid date set, receipts in sequence', async () => {
    const { newFee, pay } = setup();
    const fee = newFee();
    await pay(fee.id as string, 20000);
    const second = await pay(fee.id as string, 30000, { method: 'UPI' });

    expect(second.payment.receiptNo).toBe('R-000002');
    expect(second.fee).toMatchObject({ amountPaid: 500, balance: 0, status: 'PAID', paidAt: NOW.toISOString() });
    expect(fee.status).toBe('PAID');
  });

  it('numbers receipts per gym, starting again at 1 in another gym', async () => {
    const { db, owner, newFee, pay } = setup();
    await pay(newFee().id as string, 10000);
    const otherGym = db.seed.gym({ code: 'OTHER2' });
    db.seed.sub({ gymId: otherGym.id });
    db.seed.member({ gymId: otherGym.id, userId: owner.id, role: 'OWNER' });
    const otherMember = db.seed.member({ gymId: otherGym.id, userId: db.seed.user().id, role: 'MEMBER' });
    const otherFee = db.seed.fee({ gymId: otherGym.id, gymMemberId: otherMember.id });
    const service = new PaymentsService(db.prisma as never, new GymAccessService(db.prisma as never));
    const result = await service.record(owner.id, otherGym.id, otherFee.id as string, { amount: 10000, method: 'CASH' } as never, undefined);
    expect(result.payment.receiptNo).toBe('R-000001');
  });

  it('refuses a payment above the balance, and records nothing', async () => {
    const { db, newFee, pay } = setup();
    const fee = newFee({ amountPaid: 200, status: 'PARTIAL' });
    expect(await failure(pay(fee.id as string, 30001))).toEqual({ status: 409, code: 'PAYMENT_EXCEEDS_BALANCE' });
    expect(db.state.payments).toHaveLength(0);
    expect(fee.amountPaid).toBe(200);
  });

  it('refuses fully paid and waived fees', async () => {
    const { newFee, pay } = setup();
    expect(await failure(pay(newFee({ amountPaid: 500, status: 'PAID' }).id as string, 100))).toEqual({ status: 409, code: 'FEE_ALREADY_PAID' });
    expect(await failure(pay(newFee({ status: 'WAIVED' }).id as string, 100))).toEqual({ status: 409, code: 'FEE_WAIVED' });
  });

  it('accepts a payment date up to 30 days back and a few minutes of clock skew, but not older or later', async () => {
    const { newFee, pay } = setup();
    const fee = newFee();
    await expect(pay(fee.id as string, 10000, { paidAt: new Date(NOW.getTime() - 29 * DAY) })).resolves.toBeDefined();
    await expect(pay(fee.id as string, 10000, { paidAt: new Date(NOW.getTime() + 4 * 60_000) })).resolves.toBeDefined();
    for (const paidAt of [new Date(NOW.getTime() - 31 * DAY), new Date(NOW.getTime() + DAY)]) {
      expect(await failure(pay(fee.id as string, 10000, { paidAt }))).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });

  it('rolls everything back when the fee was changed by another request', async () => {
    const { db, newFee, pay } = setup();
    const fee = newFee();
    vi.spyOn(db.models.memberFee, 'updateMany').mockResolvedValueOnce({ count: 0 });
    expect(await failure(pay(fee.id as string, 20000))).toEqual({ status: 409, code: 'FEE_CHANGED' });
    expect(db.state.payments).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
    expect(fee.amountPaid).toBe(0);
  });

  it('retries when the receipt number is taken by a simultaneous payment', async () => {
    const { db, newFee, pay } = setup();
    vi.spyOn(db.models.feePayment, 'create').mockRejectedValueOnce(new FakeUniqueError());
    const result = await pay(newFee().id as string, 10000);
    expect(result.payment.receiptNo).toBe('R-000001');
    expect(db.state.payments).toHaveLength(1);
  });

  it('gives up with RECEIPT_NUMBER_BUSY after five collisions', async () => {
    const { db, newFee, pay } = setup();
    const spy = vi.spyOn(db.models.feePayment, 'create').mockRejectedValue(new FakeUniqueError());
    expect(await failure(pay(newFee().id as string, 10000))).toEqual({ status: 409, code: 'RECEIPT_NUMBER_BUSY' });
    expect(spy).toHaveBeenCalledTimes(5);
    expect(db.state.payments).toHaveLength(0);
  });

  it('answers 404 for unknown, bad and foreign fee ids', async () => {
    const { db, pay } = setup();
    const stray = db.seed.fee({ gymId: db.seed.gym({ code: 'OTHER2' }).id, gymMemberId: 'x' });
    for (const id of ['33333333-3333-4333-8333-333333333333', 'not-a-uuid', stray.id as string]) {
      expect(await failure(pay(id, 10000))).toEqual({ status: 404, code: 'FEE_NOT_FOUND' });
    }
  });

  it('is for owners only, and refused in read-only and suspended gyms', async () => {
    const { db, gym, sub, member, service, newFee, pay } = setup();
    const fee = newFee();
    expect(await failure(service.record(member.userId as string, gym.id, fee.id as string, { amount: 10000, method: 'CASH' } as never, undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(pay(fee.id as string, 10000))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    sub.status = 'TRIAL';
    gym.status = 'SUSPENDED';
    expect(await failure(pay(fee.id as string, 10000))).toEqual({ status: 403, code: 'GYM_SUSPENDED' });
    expect(db.state.payments).toHaveLength(0);
  });

  it('still takes payments for a removed member’s open fee', async () => {
    const { member, newFee, pay } = setup();
    const fee = newFee();
    member.status = 'REMOVED';
    await expect(pay(fee.id as string, 10000)).resolves.toBeDefined();
  });
});

describe('PaymentsService.reverse', () => {
  async function paidTwice() {
    const env = setup();
    const fee = env.newFee();
    const first = await env.pay(fee.id as string, 30000);
    const second = await env.pay(fee.id as string, 20000);
    return { ...env, fee, first, second };
  }

  it('adds a negative X- entry, recalculates the fee and flags the original as reversed', async () => {
    const { db, gym, fee, second, reverse } = await paidTwice();
    const result = await reverse(fee.id as string, second.payment.paymentId);

    expect(result.payment).toMatchObject({
      receiptNo: 'X-000001', kind: 'REVERSAL', amount: -200, method: 'CASH',
      reversesReceiptNo: 'R-000002', note: 'REVERSAL OF R-000002: Entered the wrong amount',
    });
    expect(result.fee).toMatchObject({ amountPaid: 300, balance: 200, status: 'PARTIAL', paidAt: null });
    expect(result.fee.payments.map((p) => [p.receiptNo, p.reversed])).toEqual([['R-000001', false], ['R-000002', true], ['X-000001', false]]);
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'fee.payment_reversed', gymId: gym.id, metadata: { receiptNo: 'X-000001', reverses: 'R-000002', amount: 200 },
    });
  });

  it('returns the fee to PENDING when the only payment is reversed, and allows paying again', async () => {
    const env = setup();
    const fee = env.newFee();
    const paid = await env.pay(fee.id as string, 50000);
    expect(paid.fee.status).toBe('PAID');

    const reversed = await env.reverse(fee.id as string, paid.payment.paymentId);
    expect(reversed.fee).toMatchObject({ amountPaid: 0, balance: 500, status: 'PENDING', paidAt: null });

    const again = await env.pay(fee.id as string, 50000);
    expect(again.payment.receiptNo).toBe('R-000002');
    expect(again.fee.status).toBe('PAID');
  });

  it('refuses a second reversal, reversing a reversal entry, and payments of other fees', async () => {
    const { db, gym, fee, first, second, reverse, newFee, pay } = await paidTwice();
    const reversal = await reverse(fee.id as string, second.payment.paymentId);

    expect(await failure(reverse(fee.id as string, second.payment.paymentId))).toEqual({ status: 409, code: 'PAYMENT_ALREADY_REVERSED' });
    expect(await failure(reverse(fee.id as string, reversal.payment.paymentId))).toEqual({ status: 409, code: 'PAYMENT_NOT_REVERSIBLE' });

    const otherFee = newFee({ dueDate: d('2026-11-12') });
    const otherPayment = await pay(otherFee.id as string, 10000);
    expect(await failure(reverse(fee.id as string, otherPayment.payment.paymentId))).toEqual({ status: 404, code: 'PAYMENT_NOT_FOUND' });
    expect(await failure(reverse(fee.id as string, 'not-a-uuid'))).toEqual({ status: 404, code: 'PAYMENT_NOT_FOUND' });
    expect(db.state.payments.filter((p) => p.gymId === gym.id && p.receiptNo.startsWith('X-'))).toHaveLength(1);
    void first;
  });

  it('numbers reversal receipts in their own sequence', async () => {
    const { fee, first, second, reverse } = await paidTwice();
    expect((await reverse(fee.id as string, first.payment.paymentId)).payment.receiptNo).toBe('X-000001');
    expect((await reverse(fee.id as string, second.payment.paymentId)).payment.receiptNo).toBe('X-000002');
  });

  it('refuses waived fees', async () => {
    const { fee, first, reverse } = await paidTwice();
    fee.status = 'WAIVED';
    expect(await failure(reverse(fee.id as string, first.payment.paymentId))).toEqual({ status: 409, code: 'FEE_WAIVED' });
  });

  it('rolls everything back when the fee was changed by another request', async () => {
    const { db, fee, second, reverse } = await paidTwice();
    vi.spyOn(db.models.memberFee, 'updateMany').mockResolvedValueOnce({ count: 0 });
    expect(await failure(reverse(fee.id as string, second.payment.paymentId))).toEqual({ status: 409, code: 'FEE_CHANGED' });
    expect(db.state.payments).toHaveLength(2);
    expect(fee.amountPaid).toBe(500);
  });

  it('is for owners only, and refused in read-only gyms', async () => {
    const { gym, sub, member, fee, second, service, reverse } = await paidTwice();
    expect(await failure(service.reverse(member.userId as string, gym.id, fee.id as string, second.payment.paymentId, 'Because', undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(reverse(fee.id as string, second.payment.paymentId))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
  });
});

describe('PaymentsService.waive', () => {
  it('waives an unpaid fee: final status, the whole amount forgiven, reason audited', async () => {
    const { db, owner, gym, newFee, service } = setup();
    const fee = newFee();
    const result = await service.waive(owner.id, gym.id, fee.id as string, 'Member injured', '1.2.3.4');
    expect(result).toMatchObject({ status: 'WAIVED', balance: 0, waivedAmount: 500, amountPaid: 0 });
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'fee.waived', entityId: fee.id, metadata: { waivedAmount: 500, reason: 'Member injured' }, ip: '1.2.3.4',
    });
  });

  it('keeps what was already paid and forgives only the rest', async () => {
    const { owner, gym, newFee, pay, service } = setup();
    const fee = newFee();
    await pay(fee.id as string, 20000);
    const result = await service.waive(owner.id, gym.id, fee.id as string, 'Member injured', undefined);
    expect(result).toMatchObject({ status: 'WAIVED', amountPaid: 200, balance: 0, waivedAmount: 300 });
  });

  it('is final: no payments afterwards, and no second waive', async () => {
    const { owner, gym, newFee, pay, service } = setup();
    const fee = newFee();
    await service.waive(owner.id, gym.id, fee.id as string, 'Member injured', undefined);
    expect(await failure(pay(fee.id as string, 10000))).toEqual({ status: 409, code: 'FEE_WAIVED' });
    expect(await failure(service.waive(owner.id, gym.id, fee.id as string, 'Again', undefined))).toEqual({ status: 409, code: 'FEE_ALREADY_WAIVED' });
  });

  it('refuses a fee that is already fully paid', async () => {
    const { owner, gym, newFee, service } = setup();
    const fee = newFee({ amountPaid: 500, status: 'PAID' });
    expect(await failure(service.waive(owner.id, gym.id, fee.id as string, 'Too late', undefined))).toEqual({ status: 409, code: 'FEE_ALREADY_PAID' });
  });

  it('rolls back when the fee was changed by another request', async () => {
    const { db, owner, gym, newFee, service } = setup();
    const fee = newFee();
    vi.spyOn(db.models.memberFee, 'updateMany').mockResolvedValueOnce({ count: 0 });
    expect(await failure(service.waive(owner.id, gym.id, fee.id as string, 'Member injured', undefined))).toEqual({ status: 409, code: 'FEE_CHANGED' });
    expect(fee.status).toBe('PENDING');
    expect(db.state.audits).toHaveLength(0);
  });

  it('is for owners only, and refused in read-only gyms', async () => {
    const { owner, gym, sub, member, newFee, service } = setup();
    const fee = newFee();
    expect(await failure(service.waive(member.userId as string, gym.id, fee.id as string, 'Sneaky', undefined))).toEqual({ status: 403, code: 'GYM_FORBIDDEN' });
    sub.status = 'READ_ONLY';
    expect(await failure(service.waive(owner.id, gym.id, fee.id as string, 'Late', undefined))).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
  });
});