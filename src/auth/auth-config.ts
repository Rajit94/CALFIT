import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

export type NumericAuthKey =
  | 'JWT_ACCESS_TTL_SECONDS'
  | 'REFRESH_TTL_DAYS'
  | 'OTP_TTL_SECONDS'
  | 'OTP_MAX_ATTEMPTS'
  | 'OTP_RESEND_COOLDOWN_SECONDS'
  | 'OTP_MAX_SENDS_PER_PHONE_PER_HOUR'
  | 'OTP_MAX_SENDS_PER_IP_PER_HOUR';

export type SecretAuthKey = 'JWT_ACCESS_SECRET' | 'OTP_PEPPER';

// Fail fast at startup instead of misbehaving at runtime.
export function readNumber(config: ConfigService<Env, true>, key: NumericAuthKey): number {
  const value: unknown = config.get(key, { infer: true });
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`Missing or invalid configuration value: ${key}`);
  return n;
}

export function readSecret(config: ConfigService<Env, true>, key: SecretAuthKey): string {
  const value: unknown = config.get(key, { infer: true });
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error(`Missing or too short configuration value: ${key}`);
  }
  return value;
}