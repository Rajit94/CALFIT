import { z } from 'zod';

const intWithDefault = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must start with postgresql://'),

    // --- Authentication ---
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: intWithDefault(900, 60, 3600),
    REFRESH_TTL_DAYS: intWithDefault(30, 1, 90),

    // --- OTP ---
    OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters'),
    OTP_PROVIDER: z.enum(['console']).default('console'),
    OTP_DEV_FIXED_CODE: z
      .string()
      .regex(/^\d{6}$/, 'OTP_DEV_FIXED_CODE must be exactly 6 digits')
      .optional(),
    OTP_TTL_SECONDS: intWithDefault(300, 60, 900),
    OTP_MAX_ATTEMPTS: intWithDefault(5, 1, 10),
    OTP_RESEND_COOLDOWN_SECONDS: intWithDefault(30, 0, 600),
    OTP_MAX_SENDS_PER_PHONE_PER_HOUR: intWithDefault(5, 1, 50),
    OTP_MAX_SENDS_PER_IP_PER_HOUR: intWithDefault(20, 1, 500),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.OTP_DEV_FIXED_CODE !== undefined), {
    message: 'OTP_DEV_FIXED_CODE must not be set when NODE_ENV=production',
    path: ['OTP_DEV_FIXED_CODE'],
  });

export type Env = z.infer<typeof envSchema>;