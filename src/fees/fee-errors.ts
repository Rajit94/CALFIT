import { NotFoundException } from '@nestjs/common';
import { issuesToException } from '../common/validation/validation-pipe.js';
import { conflict } from '../gyms/gym-errors.js';

export const planNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan not found.' });

export const feeNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'FEE_NOT_FOUND', message: 'Fee not found.' });

export const paymentNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: 'Payment not found.' });

export const memberNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'Member not found.' });

export const membershipNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND', message: 'You are not a member of this gym.' });

export const feeChanged = () =>
  conflict('FEE_CHANGED', 'This fee was just changed by another request. Refresh and try again.');

// A VALIDATION_FAILED error for one field, for rules that need database values to check.
export const fieldError = (field: string, message: string) =>
  issuesToException([{ message, path: [field] }]);