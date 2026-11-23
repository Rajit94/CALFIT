import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeGymDb } from '../../test/support/fake-gym-db.js';
import { GymAccessService } from '../gyms/gym-access.service.js';
import { MembershipService } from './membership.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

function setup() {
  const db = makeGymDb();
  const owner = db.seed.user();
  const gym = db.seed.gym({ code: 'K7M2QX', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  const me = db.seed.user();
  const row = db.seed.member({ gymId: gym.id, userId: me.id, role: 'MEMBER', status: 'ACTIVE' });
  const service = new MembershipService(db.prisma as never, new GymAccessService(db.prisma as never));
  return { db, owner, gym, sub, me, row, service };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MembershipService.setWhatsappConsent', () => {
  it('opts in: stores the flag and time, a versioned consent record, and an audit entry', async () => {
    const { db, gym, me, row, service } = setup();
    expect(await service.setWhatsappConsent(me.id, gym.id, true, '1.2.3.4')).toEqual({ whatsappConsent: true });

    expect(row).toMatchObject({ whatsappConsent: true });
    expect((row.whatsappConsentAt as Date).toISOString()).toBe(NOW.toISOString());
    expect(db.state.consents).toEqual([
      expect.objectContaining({ userId: me.id, gymId: gym.id, type: 'WHATSAPP', version: '2026-11-04', revokedAt: null, ip: '1.2.3.4' }),
    ]);
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'gym_member.whatsapp_consent_changed', actorId: me.id, entityId: row.id, metadata: { whatsappConsent: true },
    });
  });

  it('is idempotent: the same answer again changes nothing', async () => {
    const { db, gym, me, service } = setup();
    await service.setWhatsappConsent(me.id, gym.id, true, undefined);
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await service.setWhatsappConsent(me.id, gym.id, true, undefined);
    expect(db.state.consents).toHaveLength(1);
    expect(db.state.audits).toHaveLength(1);
  });

  it('opts out: clears the flag and revokes the consent record', async () => {
    const { db, gym, me, row, service } = setup();
    await service.setWhatsappConsent(me.id, gym.id, true, undefined);
    expect(await service.setWhatsappConsent(me.id, gym.id, false, undefined)).toEqual({ whatsappConsent: false });

    expect(row).toMatchObject({ whatsappConsent: false, whatsappConsentAt: null });
    expect(db.state.consents[0]!.revokedAt).toBeInstanceOf(Date);
    expect(db.state.audits.at(-1)!.metadata).toEqual({ whatsappConsent: false });
  });

  it('can opt in again after opting out, creating a new consent record', async () => {
    const { db, gym, me, service } = setup();
    await service.setWhatsappConsent(me.id, gym.id, true, undefined);
    await service.setWhatsappConsent(me.id, gym.id, false, undefined);
    await service.setWhatsappConsent(me.id, gym.id, true, undefined);
    expect(db.state.consents).toHaveLength(2);
    expect(db.state.consents.filter((c) => c.revokedAt === null)).toHaveLength(1);
  });

  it('answers MEMBERSHIP_NOT_FOUND for an owner who has not joined as a member', async () => {
    const { gym, owner, service } = setup();
    expect(await failure(service.setWhatsappConsent(owner.id, gym.id, true, undefined))).toEqual({
      status: 404, code: 'MEMBERSHIP_NOT_FOUND',
    });
  });

  it('answers GYM_NOT_FOUND for strangers and for people who are only pending', async () => {
    const { db, gym, row, service } = setup();
    expect(await failure(service.setWhatsappConsent(db.seed.user().id, gym.id, true, undefined))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
    row.status = 'PENDING';
    expect(await failure(service.setWhatsappConsent(row.userId as string, gym.id, true, undefined))).toEqual({ status: 404, code: 'GYM_NOT_FOUND' });
  });

  it('works in read-only and suspended gyms', async () => {
    const { gym, sub, me, service } = setup();
    sub.status = 'READ_ONLY';
    await expect(service.setWhatsappConsent(me.id, gym.id, true, undefined)).resolves.toEqual({ whatsappConsent: true });
    sub.status = 'TRIAL';
    gym.status = 'SUSPENDED';
    await expect(service.setWhatsappConsent(me.id, gym.id, false, undefined)).resolves.toEqual({ whatsappConsent: false });
  });
});