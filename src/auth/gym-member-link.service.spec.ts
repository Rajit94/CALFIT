import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GymMemberLinkService } from './gym-member-link.service.js';

const USER = 'user-1';
const PHONE = '+919876543210';
const OTHER_PHONE = '+919876543211';
const GYM_A = 'gym-a';
const GYM_B = 'gym-b';

interface Row {
  id: string;
  gymId: string;
  userId: string | null;
  role: string;
  status: string;
  invitedPhone: string | null;
  joinedAt: Date | null;
}

// Mimics the database's "one row per gym, person and role" rule.
class FakeUniqueError extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed on (gymId, userId, role)');
    this.name = 'PrismaClientKnownRequestError';
  }
}

// An in-memory stand-in for the gym_members and audit_logs tables.
function makeEnv() {
  const rows: Row[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;

  const db = {
    gymMember: {
      findMany: async ({
        where,
      }: {
        where: { invitedPhone: string; userId: null; status: string; role: { in: string[] } };
      }) =>
        rows
          .filter(
            (r) =>
              r.invitedPhone === where.invitedPhone &&
              r.userId === null &&
              r.status === where.status &&
              where.role.in.includes(r.role),
          )
          .map((r) => ({ id: r.id, gymId: r.gymId, role: r.role, joinedAt: r.joinedAt })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; userId: null; status: string };
        data: { userId: string; status?: string; joinedAt?: Date };
      }) => {
        const hit = rows.filter(
          (r) => r.id === where.id && r.userId === null && r.status === where.status,
        );
        for (const r of hit) {
          const clash = rows.some(
            (o) => o !== r && o.gymId === r.gymId && o.userId === data.userId && o.role === r.role,
          );
          if (clash) throw new FakeUniqueError();
          r.userId = data.userId;
          if (data.status) r.status = data.status;
          if (data.joinedAt) r.joinedAt = data.joinedAt;
        }
        return { count: hit.length };
      },
    },
    auditLog: {
      findFirst: async ({ where }: { where: { action: string; entityId: string } }) =>
        audits.find((a) => a.action === where.action && a.entityId === where.entityId) ?? null,
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      }),
    },
  };

  const service = new GymMemberLinkService(db as never);

  const add = (p: Partial<Row> & { gymId: string; role: string }): Row => {
    const row: Row = {
      id: `m${++seq}`,
      userId: null,
      status: 'INVITED',
      invitedPhone: PHONE,
      joinedAt: null,
      ...p,
    };
    rows.push(row);
    return row;
  };

  return { rows, audits, db, service, add };
}

beforeAll(() => {
  Logger.overrideLogger(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('GymMemberLinkService.linkByPhone', () => {
  it('links an imported MEMBER row: sets the user, activates it and keeps the invited phone', async () => {
    const env = makeEnv();
    const row = env.add({ gymId: GYM_A, role: 'MEMBER' });

    const summary = await env.service.linkByPhone(USER, PHONE, '1.2.3.4');

    expect(summary).toEqual({ linked: [{ gymId: GYM_A, role: 'MEMBER' }], conflicts: [] });
    expect(row.userId).toBe(USER);
    expect(row.status).toBe('ACTIVE');
    expect(row.invitedPhone).toBe(PHONE);
    expect(Math.abs((row.joinedAt as Date).getTime() - Date.now())).toBeLessThan(5000);
  });

  it('keeps the join date that the import already set', async () => {
    const env = makeEnv();
    const row = env.add({
      gymId: GYM_A,
      role: 'MEMBER',
      joinedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await env.service.linkByPhone(USER, PHONE);

    expect(row.joinedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('links a TRAINER invitation but leaves it INVITED until the trainer accepts', async () => {
    const env = makeEnv();
    const row = env.add({ gymId: GYM_A, role: 'TRAINER' });

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary.linked).toEqual([{ gymId: GYM_A, role: 'TRAINER' }]);
    expect(row.userId).toBe(USER);
    expect(row.status).toBe('INVITED');
    expect(row.joinedAt).toBeNull();
  });

  it('never links an OWNER row', async () => {
    const env = makeEnv();
    const row = env.add({ gymId: GYM_A, role: 'OWNER' });

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary).toEqual({ linked: [], conflicts: [] });
    expect(row.userId).toBeNull();
    expect(env.audits).toHaveLength(0);
  });

  it('never touches removed or rejected rows', async () => {
    const env = makeEnv();
    const removed = env.add({ gymId: GYM_A, role: 'MEMBER', status: 'REMOVED' });
    const rejected = env.add({ gymId: GYM_B, role: 'MEMBER', status: 'REJECTED' });

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary.linked).toEqual([]);
    expect(removed.userId).toBeNull();
    expect(removed.status).toBe('REMOVED');
    expect(rejected.userId).toBeNull();
    expect(rejected.status).toBe('REJECTED');
  });

  it('ignores invitations for other phone numbers', async () => {
    const env = makeEnv();
    const row = env.add({ gymId: GYM_A, role: 'MEMBER', invitedPhone: OTHER_PHONE });

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary.linked).toEqual([]);
    expect(row.userId).toBeNull();
  });

  it('leaves memberships that already have a user untouched (the three rows in the dev database)', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'OWNER', status: 'ACTIVE', userId: 'user-9', invitedPhone: null });
    env.add({ gymId: GYM_A, role: 'MEMBER', status: 'REJECTED', userId: 'user-9', invitedPhone: null });
    env.add({ gymId: GYM_A, role: 'TRAINER', status: 'PENDING', userId: 'user-9', invitedPhone: null });
    const before = JSON.stringify(env.rows);

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary).toEqual({ linked: [], conflicts: [] });
    expect(JSON.stringify(env.rows)).toBe(before);
    expect(env.audits).toHaveLength(0);
  });

  it('treats a different role in the same gym as no conflict', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER', status: 'ACTIVE', userId: USER, invitedPhone: null });
    const trainer = env.add({ gymId: GYM_A, role: 'TRAINER' });

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary.linked).toEqual([{ gymId: GYM_A, role: 'TRAINER' }]);
    expect(summary.conflicts).toEqual([]);
    expect(trainer.userId).toBe(USER);
  });

  it('skips and records a conflict when the user already has that role in the gym, and still links the rest', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER', status: 'ACTIVE', userId: USER, invitedPhone: null });
    const clashing = env.add({ gymId: GYM_A, role: 'MEMBER' });
    const fine = env.add({ gymId: GYM_B, role: 'MEMBER' });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const summary = await env.service.linkByPhone(USER, PHONE, '1.2.3.4');

    expect(summary.linked).toEqual([{ gymId: GYM_B, role: 'MEMBER' }]);
    expect(summary.conflicts).toEqual([{ gymId: GYM_A, role: 'MEMBER' }]);
    expect(clashing.userId).toBeNull();
    expect(clashing.status).toBe('INVITED');
    expect(fine.userId).toBe(USER);

    const conflictAudit = env.audits.find((a) => a.action === 'gym_member.link_conflict');
    expect(conflictAudit).toMatchObject({
      actorId: USER,
      gymId: GYM_A,
      entityType: 'gym_member',
      entityId: clashing.id,
      ip: '1.2.3.4',
    });
    expect(env.audits.some((a) => a.action === 'gym_member.linked_by_phone')).toBe(true);

    const logged = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('+91******3210');
    expect(logged).not.toContain(PHONE);
  });

  it('reports an unresolved conflict once, not on every sign-in', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER', status: 'ACTIVE', userId: USER, invitedPhone: null });
    env.add({ gymId: GYM_A, role: 'MEMBER' });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const first = await env.service.linkByPhone(USER, PHONE);
    const second = await env.service.linkByPhone(USER, PHONE);

    expect(first.conflicts).toHaveLength(1);
    expect(second.conflicts).toHaveLength(1);
    expect(env.audits.filter((a) => a.action === 'gym_member.link_conflict')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps linking when the already-reported lookup fails', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER', status: 'ACTIVE', userId: USER, invitedPhone: null });
    env.add({ gymId: GYM_A, role: 'MEMBER' });
    const fine = env.add({ gymId: GYM_B, role: 'MEMBER' });
    (env.db.auditLog as { findFirst: unknown }).findFirst = vi
      .fn()
      .mockRejectedValue(new Error('db down'));

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary.conflicts).toHaveLength(1);
    expect(summary.linked).toEqual([{ gymId: GYM_B, role: 'MEMBER' }]);
    expect(fine.userId).toBe(USER);
  });

  it('writes one audit entry per linking run, and none when nothing was linked', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER' });
    env.add({ gymId: GYM_B, role: 'TRAINER' });

    await env.service.linkByPhone(USER, PHONE, '1.2.3.4');

    expect(env.audits).toHaveLength(1);
    expect(env.audits[0]).toMatchObject({
      actorId: USER,
      action: 'gym_member.linked_by_phone',
      entityType: 'gym_member',
      ip: '1.2.3.4',
      metadata: {
        count: 2,
        memberships: [
          { gymId: GYM_A, role: 'MEMBER' },
          { gymId: GYM_B, role: 'TRAINER' },
        ],
      },
    });

    const empty = makeEnv();
    await empty.service.linkByPhone(USER, PHONE);
    expect(empty.audits).toHaveLength(0);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER' });

    await env.service.linkByPhone(USER, PHONE);
    const second = await env.service.linkByPhone(USER, PHONE);

    expect(second).toEqual({ linked: [], conflicts: [] });
    expect(env.audits).toHaveLength(1);
  });

  it('treats losing a race as a normal skip: another sign-in linked the row first', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER' });
    vi.spyOn(env.db.gymMember, 'updateMany').mockResolvedValueOnce({ count: 0 });

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary).toEqual({ linked: [], conflicts: [] });
    expect(env.audits).toHaveLength(0);
  });

  it('still links when the audit write fails', async () => {
    const env = makeEnv();
    const row = env.add({ gymId: GYM_A, role: 'MEMBER' });
    env.db.auditLog.create.mockRejectedValue(new Error('db down'));

    const summary = await env.service.linkByPhone(USER, PHONE);

    expect(summary.linked).toEqual([{ gymId: GYM_A, role: 'MEMBER' }]);
    expect(row.userId).toBe(USER);
  });

  it('passes unexpected database errors up, so the caller can log them and retry at the next sign-in', async () => {
    const env = makeEnv();
    env.add({ gymId: GYM_A, role: 'MEMBER' });
    vi.spyOn(env.db.gymMember, 'updateMany').mockRejectedValueOnce(new Error('connection lost'));

    await expect(env.service.linkByPhone(USER, PHONE)).rejects.toThrow('connection lost');
  });
});