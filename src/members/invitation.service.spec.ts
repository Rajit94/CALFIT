import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure } from '../../test/support/failure.js';
import { makeGymDb } from '../../test/support/fake-gym-db.js';
import type { Row } from '../../test/support/fake-gym-db.js';
import { InvitationService } from './invitation.service.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

function setup() {
  const db = makeGymDb();
  const owner = db.seed.user();
  const gym = db.seed.gym({ code: 'K7M2QX', name: 'Test Gym', createdById: owner.id });
  const sub = db.seed.sub({ gymId: gym.id });
  db.seed.member({ gymId: gym.id, userId: owner.id, role: 'OWNER' });
  const me = db.seed.user();
  const invited = (over: Row = {}) =>
    db.seed.member({ gymId: gym.id, userId: me.id, role: 'MEMBER', status: 'INVITED', invitedPhone: me.phone, ...over });
  const service = new InvitationService(db.prisma as never);
  const accept = (consent = true, gymId: string = gym.id) => service.accept(me.id, gymId, consent, '1.2.3.4');
  return { db, owner, gym, sub, me, invited, service, accept };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('InvitationService.accept', () => {
  it('activates the invited membership, records the WhatsApp consent, and audits', async () => {
    const { db, gym, me, invited, accept } = setup();
    const row = invited();
    expect(await accept(true)).toEqual({ gymId: gym.id, gymName: 'Test Gym', status: 'ACTIVE' });

    expect(row).toMatchObject({ status: 'ACTIVE', whatsappConsent: true, removedAt: null });
    expect((row.joinedAt as Date).toISOString()).toBe(NOW.toISOString());
    expect(db.state.consents).toEqual([
      expect.objectContaining({ userId: me.id, gymId: gym.id, type: 'WHATSAPP', version: '2026-11-04', revokedAt: null }),
    ]);
    expect(db.state.audits.at(-1)).toMatchObject({
      action: 'gym_member.invitation_accepted', actorId: me.id, gymId: gym.id, entityId: row.id, ip: '1.2.3.4',
    });
  });

  it('keeps an earlier join date, and records no consent when WhatsApp is declined', async () => {
    const { db, invited, accept } = setup();
    const row = invited({ joinedAt: new Date('2026-09-01T00:00:00.000Z') });
    await accept(false);
    expect(row.joinedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(row).toMatchObject({ whatsappConsent: false, whatsappConsentAt: null });
    expect(db.state.consents).toHaveLength(0);
  });

  it('revokes an earlier consent when the answer is now no', async () => {
    const { db, gym, me, invited, accept } = setup();
    invited();
    db.state.consents.push({ id: 'c1', userId: me.id, gymId: gym.id, type: 'WHATSAPP', revokedAt: null });
    await accept(false);
    expect(db.state.consents[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it('answers ALREADY_MEMBER for active members', async () => {
    const { invited, accept } = setup();
    invited({ status: 'ACTIVE' });
    expect(await failure(accept())).toEqual({ status: 409, code: 'ALREADY_MEMBER' });
  });

  it('answers INVITATION_NOT_FOUND when there is no invitation: pending, removed, rejected, none, or a bad id', async () => {
    const { db, gym, me, invited, accept } = setup();
    expect(await failure(accept())).toEqual({ status: 404, code: 'INVITATION_NOT_FOUND' });
    const row = invited({ status: 'PENDING' });
    for (const status of ['PENDING', 'REMOVED', 'REJECTED']) {
      row.status = status;
      expect(await failure(accept())).toEqual({ status: 404, code: 'INVITATION_NOT_FOUND' });
    }
    expect(await failure(accept(true, 'not-a-uuid'))).toEqual({ status: 404, code: 'INVITATION_NOT_FOUND' });
    expect(await failure(accept(true, '33333333-3333-4333-8333-333333333333'))).toEqual({ status: 404, code: 'INVITATION_NOT_FOUND' });
    void db; void gym; void me;
  });

  it('does not accept an invitation that has no account yet (it is linked by phone instead)', async () => {
    const { db, gym, accept } = setup();
    db.seed.member({ gymId: gym.id, userId: null, role: 'MEMBER', status: 'INVITED', invitedPhone: '+919000000001' });
    expect(await failure(accept())).toEqual({ status: 404, code: 'INVITATION_NOT_FOUND' });
  });

  it('hides suspended gyms, and refuses read-only ones', async () => {
    const { gym, sub, invited, accept } = setup();
    const row = invited();
    gym.status = 'SUSPENDED';
    expect(await failure(accept())).toEqual({ status: 404, code: 'INVITATION_NOT_FOUND' });
    gym.status = 'ACTIVE';
    sub.status = 'READ_ONLY';
    expect(await failure(accept())).toEqual({ status: 403, code: 'GYM_READ_ONLY' });
    expect(row.status).toBe('INVITED');
  });

  it('cannot be used twice', async () => {
    const { invited, accept } = setup();
    invited();
    await accept();
    expect(await failure(accept())).toEqual({ status: 409, code: 'ALREADY_MEMBER' });
  });
});