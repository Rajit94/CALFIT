import { ALLOWED_TEST_DATABASES, assertScratchDatabase } from './scratch-db-guard.js';

export { ALLOWED_TEST_DATABASES };

// Test-only secrets. They never leave the test process.
export const E2E_JWT_SECRET = 'e2e-jwt-secret-' + 'j'.repeat(32);
export const E2E_OTP_PEPPER = 'e2e-otp-pepper-' + 'p'.repeat(32);

// Verifies TEST_DATABASE_URL, then points the whole app at it. Variables set here win over .env.
// The limits are tight on purpose, so lockouts and rate limits can be tested in a few requests.
export function configureE2eEnvironment(): string {
  const { url, database } = assertScratchDatabase(process.env.TEST_DATABASE_URL);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    JWT_ACCESS_SECRET: E2E_JWT_SECRET,
    JWT_ACCESS_TTL_SECONDS: '900',
    REFRESH_TTL_DAYS: '30',
    OTP_PEPPER: E2E_OTP_PEPPER,
    OTP_PROVIDER: 'console',
    OTP_DEV_FIXED_CODE: '123456',
    OTP_TTL_SECONDS: '300',
    OTP_MAX_ATTEMPTS: '3',
    OTP_RESEND_COOLDOWN_SECONDS: '0',
    OTP_MAX_SENDS_PER_PHONE_PER_HOUR: '6',
    OTP_MAX_SENDS_PER_IP_PER_HOUR: '500',
  });
  return database;
}