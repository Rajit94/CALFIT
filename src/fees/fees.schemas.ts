import { z } from 'zod';
import { parseIsoDate } from '../common/profile/age.js';
import { isUuid } from '../common/uuid.js';
import { isoDateSchema } from '../gyms/gyms.schemas.js';
import { nameSchema } from '../users/users.schemas.js';
import { EFFECTIVE_FEE_STATUSES } from './fee-status.js';
import { MAX_DURATION_DAYS } from './fees.constants.js';
import { MAX_AMOUNT_PAISE, MIN_AMOUNT_PAISE, isWholePaise, toPaise } from './money.js';

const CONTROL = /[\u0000-\u001F\u007F]/;

// Amounts arrive as rupees (a number with at most 2 decimals) and become WHOLE PAISE in the parsed result.
export const rupeesSchema = z
  .number()
  .refine((v) => isWholePaise(v), 'Amounts can have at most 2 decimal places')
  .refine(
    (v) => toPaise(v) >= MIN_AMOUNT_PAISE && toPaise(v) <= MAX_AMOUNT_PAISE,
    'Amount must be between Rs 1 and Rs 10,00,000',
  )
  .transform(toPaise);

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} can be at most ${max} characters`)
    .refine((v) => !CONTROL.test(v), `${label} contains invalid characters`)
    .transform((v) => (v === '' ? null : v));

export const reasonSchema = z
  .string()
  .trim()
  .min(3, 'Give a short reason (at least 3 characters)')
  .max(200, 'The reason can be at most 200 characters')
  .refine((v) => !CONTROL.test(v), 'The reason contains invalid characters');

const durationSchema = z
  .number()
  .int()
  .min(1, 'Duration must be at least 1 day')
  .max(MAX_DURATION_DAYS, `Duration can be at most ${MAX_DURATION_DAYS} days`);

export const createPlanSchema = z.object({
  name: nameSchema,
  description: optionalText('Description', 200).optional(),
  durationDays: durationSchema,
  price: rupeesSchema,
});
export type CreatePlanDto = z.infer<typeof createPlanSchema>;

// Strict on purpose. A price or duration change affects FUTURE cycles only.
export const updatePlanSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: optionalText('Description', 200).optional(),
    durationDays: durationSchema.optional(),
    price: rupeesSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');
export type UpdatePlanDto = z.infer<typeof updatePlanSchema>;

export const listPlansQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const assignFeeSchema = z.object({
  planId: z.string().refine((v) => isUuid(v), 'Invalid plan id'),
  startDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  amount: rupeesSchema.optional(),
  amountReason: reasonSchema.optional(),
});
export type AssignFeeDto = z.infer<typeof assignFeeSchema>;

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const;

const paidAtSchema = z
  .string()
  .trim()
  .refine((v) => {
    const shape = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
    return shape.test(v) && parseIsoDate(v.slice(0, 10)) !== null && !Number.isNaN(Date.parse(v));
  }, 'Use a date (YYYY-MM-DD) or a full date-time with a time zone, like 2026-11-04T10:30:00+05:30')
  .transform((v) => new Date(v));

export const recordPaymentSchema = z.object({
  amount: rupeesSchema,
  method: z.enum(PAYMENT_METHODS),
  paidAt: paidAtSchema.optional(),
  note: optionalText('Note', 200).optional(),
});
export type RecordPaymentDto = z.infer<typeof recordPaymentSchema>;

export const reasonBodySchema = z.object({ reason: reasonSchema });
export type ReasonBodyDto = z.infer<typeof reasonBodySchema>;

export const listFeesQuerySchema = z
  .object({
    status: z.string().trim().toUpperCase().pipe(z.enum(EFFECTIVE_FEE_STATUSES)).optional(),
    memberId: z.string().refine((v) => isUuid(v), 'Invalid member id').optional(),
    dueFrom: isoDateSchema.optional(),
    dueTo: isoDateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().refine((v) => isUuid(v), 'Invalid cursor').optional(),
  })
  .refine((v) => v.dueFrom === undefined || v.dueTo === undefined || v.dueFrom <= v.dueTo, {
    message: '"dueTo" must not be before "dueFrom"',
    path: ['dueTo'],
  });
export type ListFeesQuery = z.infer<typeof listFeesQuerySchema>;

export const acceptInvitationSchema = z.object({ whatsappConsent: z.boolean() });
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;