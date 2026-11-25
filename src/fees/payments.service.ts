import { Injectable } from '@nestjs/common';
import { istDateString } from '../common/profile/age.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { isUuid } from '../common/uuid.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { conflict } from '../gyms/gym-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { feeChanged, feeNotFound, fieldError, paymentNotFound } from './fee-errors.js';
import { loadFeeDetail } from './fee-reader.js';
import { storedStatusFor } from './fee-status.js';
import type { FeeDetail, PaymentItem } from './fee-view.js';
import { CLOCK_SKEW_MS, PAYMENT_BACKDATE_DAYS } from './fees.constants.js';
import type { RecordPaymentDto } from './fees.schemas.js';
import { formatRupees, fromPaise, toPaise } from './money.js';
import { buildReversalNote, isReversalReceipt, nextReceiptNo, parseReversalTarget } from './receipt.js';

const MAX_RECEIPT_ATTEMPTS = 5;

export interface PaymentResult {
  payment: PaymentItem;
  fee: FeeDetail;
}

// Receipt numbers are allocated by reading the highest number and adding one, so two simultaneous
// payments can pick the same number. The unique index stops that; the loser simply tries again.
async function withReceiptRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (attempt >= MAX_RECEIPT_ATTEMPTS) {
        throw conflict('RECEIPT_NUMBER_BUSY', 'Could not allocate a receipt number. Please try again.');
      }
    }
  }
}

// Money rules. Payments can never be edited or deleted: a mistake is fixed with a reversal entry.
// Every change updates the fee only if it is unchanged since it was read; the loser of a race gets FEE_CHANGED.
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GymAccessService,
  ) {}

  async record(
    ownerId: string,
    gymId: string,
    feeId: string,
    dto: RecordPaymentDto,
    ip: string | undefined,
  ): Promise<PaymentResult> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);

    const fee = await this.loadFee(gymId, feeId);
    if (fee.status === 'WAIVED') throw conflict('FEE_WAIVED', 'This fee was waived and cannot take payments.');

    const amountPaise = toPaise(fee.amount);
    const paidPaise = toPaise(fee.amountPaid);
    const balance = amountPaise - paidPaise;
    if (balance <= 0) throw conflict('FEE_ALREADY_PAID', 'This fee is already fully paid.');
    if (dto.amount > balance) {
      throw conflict('PAYMENT_EXCEEDS_BALANCE', `The payment is more than the balance of ${formatRupees(balance)}.`);
    }

    const now = new Date();
    const paidAt = dto.paidAt ?? now;
    if (paidAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw fieldError('paidAt', 'The payment date cannot be in the future.');
    }
    if (paidAt.getTime() < now.getTime() - PAYMENT_BACKDATE_DAYS * 86_400_000) {
      throw fieldError('paidAt', `The payment date can be at most ${PAYMENT_BACKDATE_DAYS} days ago.`);
    }

    const newPaid = paidPaise + dto.amount;
    const newStatus = storedStatusFor(amountPaise, newPaid);

    const paymentId = await withReceiptRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const last = await tx.feePayment.findFirst({
          where: { gymId, receiptNo: { startsWith: 'R-' } },
          orderBy: { receiptNo: 'desc' },
          select: { receiptNo: true },
        });
        const receiptNo = nextReceiptNo('R', last?.receiptNo ?? null);

        const payment = await tx.feePayment.create({
          data: {
            gymId,
            memberFeeId: fee.id,
            gymMemberId: fee.gymMemberId,
            amount: fromPaise(dto.amount),
            method: dto.method,
            paidAt,
            receiptNo,
            note: dto.note ?? null,
            recordedById: ownerId,
          },
          select: { id: true },
        });

        const updated = await tx.memberFee.updateMany({
          where: { id: fee.id, status: fee.status, amountPaid: fee.amountPaid },
          data: {
            amountPaid: fromPaise(newPaid),
            status: newStatus,
            paidAt: newStatus === 'PAID' ? paidAt : null,
          },
        });
        if (updated.count !== 1) throw feeChanged();

        await tx.auditLog.create({
          data: {
            actorId: ownerId,
            gymId,
            action: 'fee.payment_recorded',
            entityType: 'member_fee',
            entityId: fee.id,
            metadata: { receiptNo, amount: fromPaise(dto.amount), method: dto.method },
            ip: ip ?? null,
          },
        });
        return payment.id;
      }),
    );

    return this.result(gymId, feeId, paymentId);
  }

  // Adds a NEGATIVE entry with its own receipt number (X-000001...) and a required reason.
  async reverse(
    ownerId: string,
    gymId: string,
    feeId: string,
    paymentId: string,
    reason: string,
    ip: string | undefined,
  ): Promise<PaymentResult> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);
    if (!isUuid(paymentId)) throw paymentNotFound();

    const fee = await this.loadFee(gymId, feeId);
    if (fee.status === 'WAIVED') throw conflict('FEE_WAIVED', 'Waived fees cannot be changed.');

    const payments = await this.prisma.feePayment.findMany({
      where: { memberFeeId: fee.id },
      select: { id: true, receiptNo: true, amount: true, method: true, note: true },
    });
    const original = payments.find((p) => p.id === paymentId);
    if (!original) throw paymentNotFound();

    const originalPaise = toPaise(original.amount);
    if (isReversalReceipt(original.receiptNo) || originalPaise <= 0) {
      throw conflict('PAYMENT_NOT_REVERSIBLE', 'Only payments can be reversed, not reversal entries.');
    }
    const alreadyReversed = payments.some(
      (p) => isReversalReceipt(p.receiptNo) && parseReversalTarget(p.note) === original.receiptNo,
    );
    if (alreadyReversed) throw conflict('PAYMENT_ALREADY_REVERSED', 'This payment has already been reversed.');

    const newPaid = toPaise(fee.amountPaid) - originalPaise;
    if (newPaid < 0) throw conflict('PAYMENT_NOT_REVERSIBLE', 'The fee total no longer allows this reversal.');
    const newStatus = newPaid > 0 ? 'PARTIAL' : 'PENDING';
    const now = new Date();

    const reversalId = await withReceiptRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const last = await tx.feePayment.findFirst({
          where: { gymId, receiptNo: { startsWith: 'X-' } },
          orderBy: { receiptNo: 'desc' },
          select: { receiptNo: true },
        });
        const receiptNo = nextReceiptNo('X', last?.receiptNo ?? null);

        const entry = await tx.feePayment.create({
          data: {
            gymId,
            memberFeeId: fee.id,
            gymMemberId: fee.gymMemberId,
            amount: fromPaise(-originalPaise),
            method: original.method,
            paidAt: now,
            receiptNo,
            note: buildReversalNote(original.receiptNo, reason),
            recordedById: ownerId,
          },
          select: { id: true },
        });

        const updated = await tx.memberFee.updateMany({
          where: { id: fee.id, status: fee.status, amountPaid: fee.amountPaid },
          data: { amountPaid: fromPaise(newPaid), status: newStatus, paidAt: null },
        });
        if (updated.count !== 1) throw feeChanged();

        await tx.auditLog.create({
          data: {
            actorId: ownerId,
            gymId,
            action: 'fee.payment_reversed',
            entityType: 'member_fee',
            entityId: fee.id,
            metadata: { receiptNo, reverses: original.receiptNo, amount: fromPaise(originalPaise) },
            ip: ip ?? null,
          },
        });
        return entry.id;
      }),
    );

    return this.result(gymId, feeId, reversalId);
  }

  // Forgives the remaining balance. Final: a waived fee takes no payments and cannot be changed.
  async waive(
    ownerId: string,
    gymId: string,
    feeId: string,
    reason: string,
    ip: string | undefined,
  ): Promise<FeeDetail> {
    const access = await this.access.requireOwner(ownerId, gymId);
    this.access.assertWritable(access);

    const fee = await this.loadFee(gymId, feeId);
    if (fee.status === 'WAIVED') throw conflict('FEE_ALREADY_WAIVED', 'This fee is already waived.');
    const balance = toPaise(fee.amount) - toPaise(fee.amountPaid);
    if (balance <= 0) throw conflict('FEE_ALREADY_PAID', 'This fee is already fully paid.');

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.memberFee.updateMany({
        where: { id: fee.id, status: fee.status, amountPaid: fee.amountPaid },
        data: { status: 'WAIVED', paidAt: null },
      });
      if (updated.count !== 1) throw feeChanged();
      await tx.auditLog.create({
        data: {
          actorId: ownerId,
          gymId,
          action: 'fee.waived',
          entityType: 'member_fee',
          entityId: fee.id,
          metadata: { waivedAmount: fromPaise(balance), reason },
          ip: ip ?? null,
        },
      });
    });
    return loadFeeDetail(this.prisma, gymId, feeId, istDateString());
  }

  private async loadFee(gymId: string, feeId: string) {
    if (!isUuid(feeId)) throw feeNotFound();
    const fee = await this.prisma.memberFee.findFirst({
      where: { id: feeId, gymId },
      select: { id: true, gymMemberId: true, status: true, amount: true, amountPaid: true },
    });
    if (!fee) throw feeNotFound();
    return fee;
  }

  private async result(gymId: string, feeId: string, paymentId: string): Promise<PaymentResult> {
    const fee = await loadFeeDetail(this.prisma, gymId, feeId, istDateString());
    const payment = fee.payments.find((p) => p.paymentId === paymentId);
    if (!payment) throw new Error('The new payment could not be read back');
    return { payment, fee };
  }
}