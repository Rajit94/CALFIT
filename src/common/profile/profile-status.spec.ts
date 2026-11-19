import { describe, expect, it } from 'vitest';
import { DEFAULT_PARENTAL_CONSENT_CONFIG } from './parental-consent.policy.js';
import { buildProfileStatus } from './profile-status.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const dob = (value: string) => new Date(`${value}T00:00:00.000Z`);
const done = new Date('2026-11-01T00:00:00.000Z');
const policy = DEFAULT_PARENTAL_CONSENT_CONFIG;

describe('buildProfileStatus', () => {
  it('asks a new user for profile details', () => {
    const s = buildProfileStatus({ dateOfBirth: null, profileCompletedAt: null, parentalConsent: null }, policy, NOW);
    expect(s).toMatchObject({ dateOfBirth: null, ageGroup: null, profileCompleted: false, profileNextStep: 'PROFILE_DETAILS' });
    expect(s.guardianConsent).toEqual({ required: false, status: 'NOT_REQUIRED', guardianPhoneMasked: null });
  });

  it('marks a completed adult as done', () => {
    const s = buildProfileStatus(
      { dateOfBirth: dob('1995-05-20'), profileCompletedAt: done, parentalConsent: null },
      policy,
      NOW,
    );
    expect(s).toMatchObject({ dateOfBirth: '1995-05-20', ageGroup: 'ADULT', profileCompleted: true, profileNextStep: 'DONE' });
    expect(s.guardianConsent.status).toBe('NOT_REQUIRED');
  });

  it('asks a minor without a guardian for guardian details', () => {
    const s = buildProfileStatus(
      { dateOfBirth: dob('2011-03-10'), profileCompletedAt: null, parentalConsent: null },
      policy,
      NOW,
    );
    expect(s).toMatchObject({ ageGroup: 'MINOR', profileNextStep: 'GUARDIAN_CONSENT' });
    expect(s.guardianConsent).toEqual({ required: true, status: 'NOT_STARTED', guardianPhoneMasked: null });
  });

  it('asks for the guardian code once guardian details exist', () => {
    const s = buildProfileStatus(
      {
        dateOfBirth: dob('2011-03-10'),
        profileCompletedAt: null,
        parentalConsent: { guardianPhone: '+919876543299', verifiedAt: null },
      },
      policy,
      NOW,
    );
    expect(s.profileNextStep).toBe('GUARDIAN_VERIFICATION');
    expect(s.guardianConsent).toEqual({ required: true, status: 'PENDING', guardianPhoneMasked: '+91******3299' });
  });

  it('marks a verified minor as done', () => {
    const s = buildProfileStatus(
      {
        dateOfBirth: dob('2011-03-10'),
        profileCompletedAt: done,
        parentalConsent: { guardianPhone: '+919876543299', verifiedAt: done },
      },
      policy,
      NOW,
    );
    expect(s).toMatchObject({ profileCompleted: true, profileNextStep: 'DONE' });
    expect(s.guardianConsent.status).toBe('VERIFIED');
  });

  it('does not require consent when the policy is disabled', () => {
    const s = buildProfileStatus(
      { dateOfBirth: dob('2011-03-10'), profileCompletedAt: null, parentalConsent: null },
      { ...policy, enabled: false },
      NOW,
    );
    expect(s.guardianConsent).toEqual({ required: false, status: 'NOT_REQUIRED', guardianPhoneMasked: null });
    expect(s.profileNextStep).toBe('PROFILE_DETAILS');
  });

  it('keeps a verified guardian as VERIFIED even if the policy is later disabled', () => {
    const s = buildProfileStatus(
      {
        dateOfBirth: dob('2011-03-10'),
        profileCompletedAt: done,
        parentalConsent: { guardianPhone: '+919876543299', verifiedAt: done },
      },
      { ...policy, enabled: false },
      NOW,
    );
    expect(s.guardianConsent.status).toBe('VERIFIED');
  });

  it('switches from minor to adult exactly on the 18th birthday', () => {
    const row = (value: string) => ({ dateOfBirth: dob(value), profileCompletedAt: null, parentalConsent: null });
    expect(buildProfileStatus(row('2008-11-05'), policy, NOW).ageGroup).toBe('MINOR');
    expect(buildProfileStatus(row('2008-11-04'), policy, NOW).ageGroup).toBe('ADULT');
  });
});