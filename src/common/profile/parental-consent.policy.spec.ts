import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PARENTAL_CONSENT_CONFIG,
  ParentalConsentPolicy,
} from './parental-consent.policy.js';

beforeAll(() => {
  Logger.overrideLogger(false);
});

const policyWith = (row: { value: unknown } | null) =>
  new ParentalConsentPolicy({ appConfig: { findUnique: async () => row } } as never);

describe('ParentalConsentPolicy', () => {
  it('uses the safe defaults when no row exists', async () => {
    expect(await policyWith(null).get()).toEqual(DEFAULT_PARENTAL_CONSENT_CONFIG);
    expect(DEFAULT_PARENTAL_CONSENT_CONFIG).toMatchObject({ enabled: true, minAge: 10, adultAge: 18 });
  });

  it('reads valid values from the row', async () => {
    const config = await policyWith({
      value: { enabled: false, minAge: 12, adultAge: 16, version: 'guardian-otp-v2' },
    }).get();
    expect(config).toMatchObject({ enabled: false, minAge: 12, adultAge: 16, version: 'guardian-otp-v2' });
  });

  it('fills missing fields from the defaults', async () => {
    const config = await policyWith({ value: { enabled: false } }).get();
    expect(config).toEqual({ ...DEFAULT_PARENTAL_CONSENT_CONFIG, enabled: false });
  });

  it('falls back to the safe defaults for invalid values', async () => {
    for (const value of [{ minAge: 'ten' }, { minAge: 20, adultAge: 18 }, { method: 'telepathy' }, 'text', null]) {
      expect(await policyWith({ value }).get()).toEqual(DEFAULT_PARENTAL_CONSENT_CONFIG);
    }
  });

  it('falls back to the safe defaults when the database read fails', async () => {
    const policy = new ParentalConsentPolicy({
      appConfig: {
        findUnique: async () => {
          throw new Error('db down');
        },
      },
    } as never);
    expect(await policy.get()).toEqual(DEFAULT_PARENTAL_CONSENT_CONFIG);
  });
});