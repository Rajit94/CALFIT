import { maskPhone } from '../../auth/validation.js';
import { ageInYears, istDateString, toDateOnly } from './age.js';
import type { ParentalConsentConfig } from './parental-consent.policy.js';

export type AgeGroup = 'MINOR' | 'ADULT';
export type GuardianStatus = 'NOT_REQUIRED' | 'NOT_STARTED' | 'PENDING' | 'VERIFIED';
export type ProfileNextStep = 'PROFILE_DETAILS' | 'GUARDIAN_CONSENT' | 'GUARDIAN_VERIFICATION' | 'DONE';

export interface ProfileStatusInput {
  dateOfBirth: Date | null;
  profileCompletedAt: Date | null;
  parentalConsent: { guardianPhone: string; verifiedAt: Date | null } | null;
}

export interface ProfileStatus {
  dateOfBirth: string | null;
  ageGroup: AgeGroup | null;
  profileCompleted: boolean;
  profileNextStep: ProfileNextStep;
  guardianConsent: {
    required: boolean;
    status: GuardianStatus;
    guardianPhoneMasked: string | null;
  };
}

// Tells the app which screen to show next. Pure, so it can be tested without a database.
export function buildProfileStatus(
  input: ProfileStatusInput,
  policy: ParentalConsentConfig,
  now: Date,
): ProfileStatus {
  const dob = input.dateOfBirth ? toDateOnly(input.dateOfBirth) : null;
  const age = dob ? ageInYears(dob, istDateString(now)) : null;
  const ageGroup: AgeGroup | null = age === null ? null : age < policy.adultAge ? 'MINOR' : 'ADULT';

  const required = policy.enabled && ageGroup === 'MINOR';
  const guardian = input.parentalConsent;
  const verified = guardian !== null && guardian.verifiedAt !== null;
  const status: GuardianStatus = verified
    ? 'VERIFIED'
    : !required
      ? 'NOT_REQUIRED'
      : guardian
        ? 'PENDING'
        : 'NOT_STARTED';

  const completed = input.profileCompletedAt !== null;
  let profileNextStep: ProfileNextStep;
  if (completed) profileNextStep = 'DONE';
  else if (dob === null) profileNextStep = 'PROFILE_DETAILS';
  else if (required && !verified) profileNextStep = guardian ? 'GUARDIAN_VERIFICATION' : 'GUARDIAN_CONSENT';
  else profileNextStep = 'PROFILE_DETAILS'; // details saved but not finished: submit them again to complete

  return {
    dateOfBirth: dob,
    ageGroup,
    profileCompleted: completed,
    profileNextStep,
    guardianConsent: {
      required,
      status,
      guardianPhoneMasked: guardian ? maskPhone(guardian.guardianPhone) : null,
    },
  };
}