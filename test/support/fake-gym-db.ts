import { randomUUID } from 'node:crypto';

// A small in-memory stand-in for the gym-related tables, shared by the gym unit tests.
export class FakeUniqueError extends Error {
  code = 'P2002';
  constructor() {
    super('Unique constraint failed');
    this.name = 'PrismaClientKnownRequestError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

const num = (v: unknown): number => (v instanceof Date ? v.getTime() : (v as number));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const actual = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(actual);
      if ('gte' in c && !(num(actual) >= num(c.gte))) return false;
      if ('gt' in c && !(num(actual) > num(c.gt))) return false;
      if ('lte' in c && !(num(actual) <= num(c.lte))) return false;
      if ('lt' in c && !(num(actual) < num(c.lt))) return false;
      return true;
    }
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    return actual === cond;
  });
}

// Sorts by the given keys; the "id" key is ignored so ties keep insertion order.
function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy])
    .flatMap((o) => Object.entries(o))
    .filter(([key]) => key !== 'id');
  return [...rows].sort((x, y) => {
    for (const [key, dir] of specs) {
      const a = num(x[key]);
      const b = num(y[key]);
      if (a !== b) return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

export function makeGymDb() {
  const state = {
    users: [] as Row[],
    gyms: [] as Row[],
    members: [] as Row[],
    subs: [] as Row[],
    settings: [] as Row[],
    holidays: [] as Row[],
    consents: [] as Row[],
    audits: [] as Row[],
    forcedCodeCollisions: 0,
  };

  const relate = (m: Row): Row => {
    const gym = state.gyms.find((g) => g.id === m.gymId);
    return {
      ...m,
      gym: gym ? { ...gym, subscription: state.subs.find((s) => s.gymId === gym.id) ?? null } : null,
      user: state.users.find((u) => u.id === m.userId) ?? null,
    };
  };

  const models = {
    appConfig: { findUnique: async () => null },
    user: {
      findUnique: async ({ where }: { where: Row }) => state.users.find((u) => matches(u, where)) ?? null,
    },
    gym: {
      create: async ({ data }: { data: Row }) => {
        if (state.forcedCodeCollisions > 0) {
          state.forcedCodeCollisions -= 1;
          throw new FakeUniqueError();
        }
        if (state.gyms.some((g) => g.code === data.code)) throw new FakeUniqueError();
        const row: Row = {
          id: randomUUID(), description: null, address: null, city: null, state: null, pincode: null,
          checkInRadiusM: 150, timezone: 'Asia/Kolkata', timings: null, logoUrl: null, coverUrl: null,
          isVerified: false, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(), ...data,
        };
        state.gyms.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Row }) => {
        const gym = state.gyms.find((g) => matches(g, where));
        return gym ? { ...gym, subscription: state.subs.find((s) => s.gymId === gym.id) ?? null } : null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const gym = state.gyms.find((g) => g.id === where.id);
        if (!gym) throw new Error('Record not found');
        Object.assign(gym, data, { updatedAt: new Date() });
        return gym;
      },
    },
    gymMember: {
      findMany: async ({ where, orderBy, take, cursor, skip }: Row) => {
        let rows = sortRows(state.members.filter((m) => matches(m, where)), orderBy);
        if (cursor) {
          const i = rows.findIndex((r) => r.id === cursor.id);
          rows = i >= 0 ? rows.slice(i + (skip ?? 0)) : [];
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map(relate);
      },
      findFirst: async ({ where }: { where: Row }) => {
        const m = state.members.find((x) => matches(x, where));
        return m ? relate(m) : null;
      },
      count: async ({ where }: { where: Row }) => state.members.filter((m) => matches(m, where)).length,
      create: async ({ data }: { data: Row }) => {
        if (
          data.userId &&
          state.members.some((m) => m.gymId === data.gymId && m.userId === data.userId && m.role === data.role)
        ) {
          throw new FakeUniqueError();
        }
        const row: Row = {
          id: randomUUID(), userId: null, invitedPhone: null, invitedName: null, whatsappConsent: false,
          whatsappConsentAt: null, joinedAt: null, approvedAt: null, approvedById: null, removedAt: null,
          createdAt: new Date(), updatedAt: new Date(), ...data,
        };
        state.members.push(row);
        return relate(row);
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.members.find((m) => m.id === where.id);
        if (!row) throw new Error('Record not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.members.filter((m) => matches(m, where));
        for (const row of hit) Object.assign(row, data, { updatedAt: new Date() });
        return { count: hit.length };
      },
    },
    gymSubscription: {
      create: async ({ data }: { data: Row }) => {
        const row: Row = {
          id: randomUUID(), trialReminderSentAt: null, currentPeriodStart: null, currentPeriodEnd: null,
          graceEndsAt: null, cancelledAt: null, ...data,
        };
        state.subs.push(row);
        return row;
      },
    },
    gymReminderSettings: {
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: randomUUID(), ...data };
        state.settings.push(row);
        return row;
      },
    },
    gymHoliday: {
      findMany: async ({ where, orderBy, take }: Row) => {
        let rows = sortRows(state.holidays.filter((h) => matches(h, where)), orderBy);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows;
      },
      findFirst: async ({ where }: { where: Row }) => state.holidays.find((h) => matches(h, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        if (state.holidays.some((h) => h.gymId === data.gymId && num(h.date) === num(data.date))) {
          throw new FakeUniqueError();
        }
        const row: Row = { id: randomUUID(), reason: null, ...data };
        state.holidays.push(row);
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        const i = state.holidays.findIndex((h) => h.id === where.id);
        if (i >= 0) state.holidays.splice(i, 1);
        return {};
      },
    },
    consentRecord: {
      findFirst: async ({ where }: { where: Row }) => state.consents.find((c) => matches(c, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: randomUUID(), version: null, gymId: null, grantedAt: new Date(), revokedAt: null, ip: null, ...data };
        state.consents.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.consents.filter((c) => matches(c, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: randomUUID(), createdAt: new Date(), ...data };
        state.audits.push(row);
        return row;
      },
    },
  };

  const prisma = {
    ...models,
    $transaction: async (fn: (tx: typeof models) => Promise<unknown>) => fn(models),
  };

  let userCounter = 0;
  const seed = {
    user: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(),
        phone: `+9198765${String(10000 + ++userCounter)}`,
        name: 'Test User',
        username: `user${userCounter}`,
        avatarUrl: null,
        dateOfBirth: new Date('1995-05-20T00:00:00.000Z'),
        profileCompletedAt: new Date('2026-10-01T00:00:00.000Z'),
        ...over,
      };
      state.users.push(row);
      return row;
    },
    gym: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(), name: 'Seed Gym', code: 'SEED22', description: null, address: null, city: 'Jabalpur',
        state: null, pincode: null, latitude: 23.18, longitude: 79.98, checkInRadiusM: 150,
        timezone: 'Asia/Kolkata', timings: null, logoUrl: null, coverUrl: null, isVerified: false,
        status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(), ...over,
      };
      state.gyms.push(row);
      return row;
    },
    sub: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(), status: 'TRIAL', trialStartsAt: new Date(), trialEndsAt: new Date(Date.now() + 5_000_000_000),
        currentPeriodEnd: null, graceEndsAt: null, pricePerMonth: 499, monthlyMessageLimit: 1000, ...over,
      };
      state.subs.push(row);
      return row;
    },
    member: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(), userId: null, invitedPhone: null, invitedName: null, role: 'MEMBER', status: 'ACTIVE',
        whatsappConsent: false, whatsappConsentAt: null, joinedAt: null, approvedAt: null, approvedById: null,
        removedAt: null, createdAt: new Date(), updatedAt: new Date(), ...over,
      };
      state.members.push(row);
      return row;
    },
  };

  return { prisma, models, state, seed };
}