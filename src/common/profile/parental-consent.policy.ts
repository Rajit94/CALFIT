import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';

// Rules for guardian consent, adjustable WITHOUT a deploy: the app_config row with key "consent.parental".
// Example value: {"enabled": true, "minAge": 10, "adultAge": 18, "version": "guardian-otp-v1"}
//
// IMPORTANT: the only method implemented today ("guardian_phone_otp") verifies that someone controls the
// guardian's phone number. It does NOT establish legal guardianship and is not a claim of DPDP compliance.
// Change "version" when the method changes, so consents given under the older method can be found
// (consent_records.version) and re-verified.
export const PARENTAL_CONSENT_CONFIG_KEY = 'consent.parental';

const configSchema = z
  .object({
    enabled: z.boolean().default(true),
    minAge: z.number().int().min(1).max(17).default(10),
    adultAge: z.number().int().min(13).max(25).default(18),
    method: z.literal('guardian_phone_otp').default('guardian_phone_otp'),
    version: z.string().min(1).max(64).default('guardian-otp-v1'),
  })
  .refine((config) => config.minAge < config.adultAge, 'minAge must be below adultAge');

export type ParentalConsentConfig = z.infer<typeof configSchema>;

// Used when the row is missing or invalid: consent stays required (fail closed).
export const DEFAULT_PARENTAL_CONSENT_CONFIG: ParentalConsentConfig = {
  enabled: true,
  minAge: 10,
  adultAge: 18,
  method: 'guardian_phone_otp',
  version: 'guardian-otp-v1',
};

@Injectable()
export class ParentalConsentPolicy {
  private readonly logger = new Logger(ParentalConsentPolicy.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<ParentalConsentConfig> {
    let row: { value: unknown } | null;
    try {
      row = await this.prisma.appConfig.findUnique({
        where: { key: PARENTAL_CONSENT_CONFIG_KEY },
        select: { value: true },
      });
    } catch (error) {
      this.logger.error(
        'Could not read the parental consent configuration; using safe defaults',
        error instanceof Error ? error.stack : String(error),
      );
      return DEFAULT_PARENTAL_CONSENT_CONFIG;
    }
    if (!row) return DEFAULT_PARENTAL_CONSENT_CONFIG;

    const parsed = configSchema.safeParse(row.value);
    if (!parsed.success) {
      this.logger.warn(`Invalid "${PARENTAL_CONSENT_CONFIG_KEY}" configuration; using safe defaults`);
      return DEFAULT_PARENTAL_CONSENT_CONFIG;
    }
    return parsed.data;
  }
}