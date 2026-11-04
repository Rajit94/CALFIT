import { z } from 'zod';
import { otpCodeSchema, phoneSchema } from './validation.js';

export const requestOtpSchema = z.object({
  phone: phoneSchema,
});
export type RequestOtpDto = z.infer<typeof requestOtpSchema>;

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
  // The phone screen has a Terms + Privacy checkbox; the app sends true on every verify.
  acceptedTerms: z
    .boolean()
    .refine((value) => value === true, 'You must accept the Terms and Privacy Policy'),
  device: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      platform: z.enum(['ios', 'android', 'web']).optional(),
    })
    .optional(),
});
export type VerifyOtpDto = z.infer<typeof verifyOtpSchema>;