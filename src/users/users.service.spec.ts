import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParentalConsentPolicy } from '../common/profile/parental-consent.policy.js';
import { UsersService } from './users.service.js';

// "Today" (IST) in every test below is 2026-11-04.
const ME = 'user-1';
const OTHER = 'user-2';
const MY_PHONE = '+919876543210';
const GUARDIAN_PHONE = '+919876543299';
const ADULT_DOB = '1995-05-20'; // 31
const MINOR_DOB = '2011-03-10'; // 15
const TURNS_18_TOMORROW = '2008-11-05'; // 17
const TURNED_18_TODAY = '2008-11-04'; // 18
const TURNS_10_TODAY = '2016-11-04'; // 10
const TOO_YOUNG_DOB = '2016-11-05'; // 9

interface UserRow {
  id: string;
  phone: string;
  username: string | null;
  name: string | null;
  bio: string | null;
  privacy: string;
  dateOfBirth: Date | null;
  profileCompletedAt: Date | null;
}
interface ConsentRow {
  userId: string;
  guardianName: string;
  guardianPhone: string;
  verifiedAt: Date | null;
}

class FakeUniqueError extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
  }
}

// In-memory stand-ins for users, parental_consents, consent_records, audit_logs and app_config.
function makeEnv(config?: unknown) {
  const users: UserRow[] = [
    { id: ME, phone: MY_PHONE, username: null, name: null, bio: null, privacy: 'PUBLIC', dateOfBirth: null, profileCompletedAt: null },
    { id: OTHER, phone: '+919876543211', username: 'taken_name', name: 'Someone', bio: null, privacy: 'PUBLIC', dateOfBirth: null, profileCompletedAt: null },
  ];
  const consents: ConsentRow[] = [];
  const records: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown> & { createdAt: Date }> = [];
  const configRow = config === undefined ? null : { value: config };

  const db = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; username?: string } }) => {
        const u =
          where.id !== undefined
            ? users.find((x) => x.id === where.id)
            : users.find((x) => x.username === where.username);
        return u ? { ...u, parentalConsent: consents.find((c) => c.userId === u.id) ?? null } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = users.find((x) => x.id === where.id) as UserRow;
        if (data.username && users.some((x) => x.id !== u.id && x.username === data.username)) {
          throw new FakeUniqueError();
        }
        Object.assign(u, data);
        return u;
      },
    },
    parentalConsent: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Omit<ConsentRow, 'verifiedAt'>;
        update: Partial<ConsentRow>;
      }) => {
        const found = consents.find((c) => c.userId === where.userId);
        if (found) {
          Object.assign(found, update);
          return found;
        }
        const row: ConsentRow = { verifiedAt: null, ...create };
        consents.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { userId: string }; data: Partial<ConsentRow> }) => {
        const found = consents.find((c) => c.userId === where.userId) as ConsentRow;
        Object.assign(found, data);
        return found;
      },
    },
    consentRecord: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        records.push(data);
        return data;
      },
    },
    auditLog: {
      findFirst: async ({ where }: { where: { actorId: string; action: string } }) =>
        audits
          .filter((a) => a.actorId === where.actorId && a.action === where.action)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push({ ...data, createdAt: new Date() });
        return data;
      },
    },
    appConfig: { findUnique: async () => configRow },
  };

  const prisma = {
    ...db,
    // Rolls everything back when the callback throws, like a real transaction.
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => {
      const snapshot = structuredClone({ users, consents, records, audits });
      try {
        return await fn(db);
      } catch (error) {
        users.splice(0, users.length, ...snapshot.users);
        consents.splice(0, consents.length, ...snapshot.consents);
        records.splice(0, records.length, ...snapshot.records);
        audits.splice(0, audits.length, ...snapshot.audits);
        throw error;
      }
    },
  };

  const otp = {
    requestOtp: vi.fn(async (_phone: string, _ip?: string) => ({ expiresInSeconds: 300, resendAfterSeconds: 30 })),
    verifyOtp: vi.fn(async (_phone: string, code: string): Promise<void> => {
      if (code !== '123456') {
        throw new BadRequestException({ code: 'OTP_INVALID', message: 'The code is incorrect.' });
      }
    }),
  };

  const service = new UsersService(prisma as never, otp as never, new ParentalConsentPolicy(prisma as never));
  const user = (id: string): UserRow => users.find((u) => u.id === id) as UserRow;
  return { service, otp, users, consents, records, audits, user };
}

const body = (over: Record<string, unknown> = {}) =>
  ({ name: 'Rajit Kumar', username: 'rajit.k', dateOfBirth: ADULT_DOB, ...over }) as never;
const guardian = { guardianName: 'Asha Kumar', guardianPhone: GUARDIAN_PHONE };

async function failure(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code };
  }
  throw new Error('Expected the promise to reject');
}

beforeAll(() => {
  Logger.overrideLogger(false);
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('UsersService.isUsernameAvailable', () => {
  it('is true for a free username, false for one taken by someone else, true for your own', async () => {
    const env = makeEnv();
    expect(await env.service.isUsernameAvailable('free_name', ME)).toBe(true);
    expect(await env.service.isUsernameAvailable('taken_name', ME)).toBe(false);
    expect(await env.service.isUsernameAvailable('taken_name', OTHER)).toBe(true);
  });
});

describe('UsersService.setupProfile', () => {
  it('completes an adult profile in one call', async () => {
    const env = makeEnv();
    const result = await env.service.setupProfile(ME, body());
    expect(result).toMatchObject({
      id: ME, username: 'rajit.k', name: 'Rajit Kumar', privacy: 'PUBLIC', dateOfBirth: ADULT_DOB,
      ageGroup: 'ADULT', profileCompleted: true, profileNextStep: 'DONE',
    });
    expect(result.guardianConsent).toEqual({ required: false, status: 'NOT_REQUIRED', guardianPhoneMasked: null });
    expect(env.user(ME).profileCompletedAt).toBeInstanceOf(Date);
  });

  it('stores the bio when given', async () => {
    const env = makeEnv();
    expect((await env.service.setupProfile(ME, body({ bio: 'Lifting daily' }))).bio).toBe('Lifting daily');
  });

  it('saves a minor but leaves the profile incomplete and private', async () => {
    const env = makeEnv();
    const result = await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect(result).toMatchObject({
      privacy: 'PRIVATE', ageGroup: 'MINOR', profileCompleted: false, profileNextStep: 'GUARDIAN_CONSENT',
    });
    expect(result.guardianConsent).toEqual({ required: true, status: 'NOT_STARTED', guardianPhoneMasked: null });
    expect(env.user(ME).profileCompletedAt).toBeNull();
  });

  it('completes a minor immediately, still private, when guardian consent is switched off', async () => {
    const env = makeEnv({ enabled: false });
    const result = await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect(result).toMatchObject({ privacy: 'PRIVATE', profileCompleted: true, profileNextStep: 'DONE' });
    expect(result.guardianConsent.status).toBe('NOT_REQUIRED');
  });

  it.each([
    [TURNED_18_TODAY, 'ADULT', 'PUBLIC'],
    [TURNS_18_TOMORROW, 'MINOR', 'PRIVATE'],
    [TURNS_10_TODAY, 'MINOR', 'PRIVATE'],
  ])('treats a date of birth of %s as %s (privacy %s)', async (dob, group, privacy) => {
    const env = makeEnv();
    const result = await env.service.setupProfile(ME, body({ dateOfBirth: dob }));
    expect(result.ageGroup).toBe(group);
    expect(result.privacy).toBe(privacy);
  });

  it('refuses someone under 10 and saves nothing', async () => {
    const env = makeEnv();
    expect(await failure(env.service.setupProfile(ME, body({ dateOfBirth: TOO_YOUNG_DOB })))).toEqual({
      status: 403, code: 'AGE_TOO_YOUNG',
    });
    expect(env.user(ME).dateOfBirth).toBeNull();
  });

  it.each(['2027-01-01', '1925-11-04', '1900-01-01'])('refuses %s as an invalid date of birth', async (dob) => {
    const env = makeEnv();
    expect(await failure(env.service.setupProfile(ME, body({ dateOfBirth: dob })))).toEqual({
      status: 400, code: 'DATE_OF_BIRTH_INVALID',
    });
    expect(env.user(ME).dateOfBirth).toBeNull();
  });

  it('accepts someone who is exactly 100', async () => {
    const env = makeEnv();
    expect((await env.service.setupProfile(ME, body({ dateOfBirth: '1926-11-04' }))).ageGroup).toBe('ADULT');
  });

  it('refuses to set up a completed profile again', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body());
    expect(await failure(env.service.setupProfile(ME, body({ name: 'Other Name' })))).toEqual({
      status: 409, code: 'PROFILE_ALREADY_COMPLETED',
    });
  });

  it('locks the date of birth, but lets an unfinished profile fix its name and username', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect(await failure(env.service.setupProfile(ME, body({ dateOfBirth: ADULT_DOB })))).toEqual({
      status: 409, code: 'DATE_OF_BIRTH_LOCKED',
    });
    const fixed = await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB, name: 'Fixed Name' }));
    expect(fixed.name).toBe('Fixed Name');
  });

  it('refuses a username that is taken, and changes nothing', async () => {
    const env = makeEnv();
    expect(await failure(env.service.setupProfile(ME, body({ username: 'taken_name' })))).toEqual({
      status: 409, code: 'USERNAME_TAKEN',
    });
    expect(env.user(ME).username).toBeNull();
  });
});

describe('UsersService.updateProfile', () => {
  it('requires a completed profile', async () => {
    const env = makeEnv();
    expect(await failure(env.service.updateProfile(ME, { name: 'New Name' }, undefined))).toEqual({
      status: 409, code: 'PROFILE_NOT_COMPLETED',
    });
  });

  it('updates name, bio and privacy, and clears the bio with null', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ bio: 'old bio' }));
    const updated = await env.service.updateProfile(ME, { name: 'New Name', bio: 'new bio', privacy: 'PRIVATE' }, undefined);
    expect(updated).toMatchObject({ name: 'New Name', bio: 'new bio', privacy: 'PRIVATE' });
    expect((await env.service.updateProfile(ME, { bio: null }, undefined)).bio).toBeNull();
    expect(env.audits).toHaveLength(0);
  });

  it('keeps people under 18 private, even after their profile is complete', async () => {
    const env = makeEnv({ enabled: false });
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect(await failure(env.service.updateProfile(ME, { privacy: 'PUBLIC' }, undefined))).toEqual({
      status: 403, code: 'MINOR_MUST_BE_PRIVATE',
    });
    expect((await env.service.updateProfile(ME, { privacy: 'PRIVATE' }, undefined)).privacy).toBe('PRIVATE');
  });

  it('lets someone who has turned 18 choose PUBLIC', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: TURNED_18_TODAY }));
    await env.service.updateProfile(ME, { privacy: 'PRIVATE' }, undefined);
    expect((await env.service.updateProfile(ME, { privacy: 'PUBLIC' }, undefined)).privacy).toBe('PUBLIC');
  });

  it('allows one username change per 30 days, recorded in audit_logs', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ username: 'first.name' }));

    const changed = await env.service.updateProfile(ME, { username: 'second.name' }, '1.2.3.4');
    expect(changed.username).toBe('second.name');
    expect(env.audits).toHaveLength(1);
    expect(env.audits[0]).toMatchObject({
      actorId: ME, action: 'user.username_changed', entityType: 'user', entityId: ME,
      metadata: { from: 'first.name', to: 'second.name' }, ip: '1.2.3.4',
    });

    expect(await failure(env.service.updateProfile(ME, { username: 'third.name' }, undefined))).toEqual({
      status: 429, code: 'USERNAME_CHANGE_TOO_SOON',
    });

    vi.setSystemTime(new Date('2026-12-03T10:00:00.000Z')); // 29 days later
    expect((await failure(env.service.updateProfile(ME, { username: 'third.name' }, undefined))).code).toBe(
      'USERNAME_CHANGE_TOO_SOON',
    );

    vi.setSystemTime(new Date('2026-12-04T10:00:00.000Z')); // 30 days later
    expect((await env.service.updateProfile(ME, { username: 'third.name' }, undefined)).username).toBe('third.name');
    expect(env.audits).toHaveLength(2);
  });

  it('does not start the clock when the username is unchanged', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ username: 'first.name' }));
    await env.service.updateProfile(ME, { username: 'first.name', name: 'Renamed Person' }, undefined);
    expect(env.audits).toHaveLength(0);
    expect((await env.service.updateProfile(ME, { username: 'other.name' }, undefined)).username).toBe('other.name');
  });

  it('refuses a username that is taken, and writes no audit entry', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ username: 'first.name' }));
    expect(await failure(env.service.updateProfile(ME, { username: 'taken_name' }, undefined))).toEqual({
      status: 409, code: 'USERNAME_TAKEN',
    });
    expect(env.user(ME).username).toBe('first.name');
    expect(env.audits).toHaveLength(0);
  });
});

describe('UsersService guardian consent', () => {
  it('stores the guardian details unverified and sends a code to the guardian phone', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    const result = await env.service.requestGuardianConsent(ME, guardian, '1.2.3.4');

    expect(result).toEqual({ guardianPhoneMasked: '+91******3299', expiresInSeconds: 300, resendAfterSeconds: 30 });
    expect(env.otp.requestOtp).toHaveBeenCalledWith(GUARDIAN_PHONE, '1.2.3.4');
    expect(env.consents).toEqual([
      { userId: ME, guardianName: 'Asha Kumar', guardianPhone: GUARDIAN_PHONE, verifiedAt: null },
    ]);
    const profile = await env.service.getProfile(ME);
    expect(profile.profileNextStep).toBe('GUARDIAN_VERIFICATION');
    expect(profile.guardianConsent.status).toBe('PENDING');
  });

  it('refuses before profile details exist', async () => {
    const env = makeEnv();
    expect(await failure(env.service.requestGuardianConsent(ME, guardian, undefined))).toEqual({
      status: 409, code: 'PROFILE_DETAILS_REQUIRED',
    });
  });

  it('refuses adults, and everyone when the policy is switched off', async () => {
    const adult = makeEnv();
    await adult.service.setupProfile(ME, body());
    expect((await failure(adult.service.requestGuardianConsent(ME, guardian, undefined))).code).toBe('GUARDIAN_NOT_REQUIRED');

    const off = makeEnv({ enabled: false });
    await off.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect((await failure(off.service.requestGuardianConsent(ME, guardian, undefined))).code).toBe('GUARDIAN_NOT_REQUIRED');
  });

  it('refuses the user’s own phone number as the guardian phone', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect(
      await failure(env.service.requestGuardianConsent(ME, { ...guardian, guardianPhone: MY_PHONE }, undefined)),
    ).toEqual({ status: 400, code: 'GUARDIAN_PHONE_INVALID' });
    expect(env.otp.requestOtp).not.toHaveBeenCalled();
  });

  it('replaces the guardian details when asked again before verification', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    await env.service.requestGuardianConsent(ME, guardian, undefined);
    await env.service.requestGuardianConsent(ME, { guardianName: 'Other Guardian', guardianPhone: '+919876543288' }, undefined);
    expect(env.consents).toHaveLength(1);
    expect(env.consents[0]).toMatchObject({ guardianName: 'Other Guardian', guardianPhone: '+919876543288' });
  });

  it('completes the profile and records a versioned PARENTAL consent when the code is right', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    await env.service.requestGuardianConsent(ME, guardian, '1.2.3.4');

    const result = await env.service.verifyGuardianConsent(ME, { code: '123456' }, '1.2.3.4');

    expect(result).toMatchObject({ profileCompleted: true, profileNextStep: 'DONE', privacy: 'PRIVATE' });
    expect(result.guardianConsent.status).toBe('VERIFIED');
    expect(env.otp.verifyOtp).toHaveBeenCalledWith(GUARDIAN_PHONE, '123456');
    expect(env.consents[0]?.verifiedAt).toBeInstanceOf(Date);
    expect(env.records).toEqual([{ userId: ME, type: 'PARENTAL', version: 'guardian-otp-v1', ip: '1.2.3.4' }]);
  });

  it('tags the consent with the version from the configuration', async () => {
    const env = makeEnv({ version: 'guardian-otp-v2' });
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    await env.service.requestGuardianConsent(ME, guardian, undefined);
    await env.service.verifyGuardianConsent(ME, { code: '123456' }, undefined);
    expect(env.records[0]?.version).toBe('guardian-otp-v2');
  });

  it('changes nothing when the code is wrong', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    await env.service.requestGuardianConsent(ME, guardian, undefined);

    expect(await failure(env.service.verifyGuardianConsent(ME, { code: '000000' }, undefined))).toEqual({
      status: 400, code: 'OTP_INVALID',
    });
    expect(env.consents[0]?.verifiedAt).toBeNull();
    expect(env.records).toHaveLength(0);
    expect(env.user(ME).profileCompletedAt).toBeNull();
  });

  it('refuses verification that was never requested, and a second verification', async () => {
    const env = makeEnv();
    await env.service.setupProfile(ME, body({ dateOfBirth: MINOR_DOB }));
    expect((await failure(env.service.verifyGuardianConsent(ME, { code: '123456' }, undefined))).code).toBe(
      'GUARDIAN_NOT_REQUESTED',
    );

    await env.service.requestGuardianConsent(ME, guardian, undefined);
    await env.service.verifyGuardianConsent(ME, { code: '123456' }, undefined);
    expect((await failure(env.service.verifyGuardianConsent(ME, { code: '123456' }, undefined))).code).toBe(
      'GUARDIAN_ALREADY_VERIFIED',
    );
    expect((await failure(env.service.requestGuardianConsent(ME, guardian, undefined))).code).toBe(
      'GUARDIAN_ALREADY_VERIFIED',
    );
  });
});