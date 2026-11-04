import { z } from 'zod';

// International format: "+", then 8-15 digits, first digit not 0.
const E164 = /^\+[1-9]\d{7,14}$/;
// Indian mobile numbers: +91 followed by 10 digits starting with 6-9.
const INDIA_MOBILE = /^\+91[6-9]\d{9}$/;

export const phoneSchema = z
  .string()
  .trim()
  .regex(E164, 'Phone number must be in international format, e.g. +919876543210')
  .refine(
    (value) => !value.startsWith('+91') || INDIA_MOBILE.test(value),
    'Enter a valid 10-digit Indian mobile number after +91',
  );

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'OTP must be exactly 6 digits');

export type PhoneNumber = z.infer<typeof phoneSchema>;

// For logs only: "+919876543210" -> "+91******3210". Never log a full phone number.
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return '*'.repeat(phone.length);
  return phone.slice(0, 3) + '*'.repeat(phone.length - 7) + phone.slice(-4);
}