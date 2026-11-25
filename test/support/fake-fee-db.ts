import { randomUUID } from 'node:crypto';
import { FakeUniqueError, makeGymDb } from './fake-gym-db.js';
import type { Row } from './fake-gym-db.js';

export { FakeUniqueError };

const num = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));
const sortKey = (v: unknown): number | string => (v instanceof Date ? v.getTime() : (v as number | string));

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    const actual = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(actual);
      if ('startsWith' in c) return typeof actual === 'string' && actual.startsWith(c.startsWith as string);
      if ('equals' in c) {
        return c.mode === 'insensitive'
          ? String(actual).toLowerCase() === String(c.equals).toLowerCase()
          : actual === c.equals;
      }
      let ok = true;
      if ('gte' in c) ok = ok && num(actual) >= num(c.gte);
      if ('gt' in c) ok = ok && num(actual) > num(c.gt);
      if ('lte' in c) ok = ok && num(actual) <= num(c.lte);
      if ('lt' in c) ok = ok && num(actual) < num(c.lt);
      return ok;
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
      const a = sortKey(x[key]);
      const b = sortKey(y[key]);
      if (a !== b) return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

// Extends the gym fake with plans, fees and payments, and makes transactions roll back like a real database.
export function makeFeeDb() {
  const gym = makeGymDb();
  const state = {
    ...gym.state,
    plans: [] as Row[],
    fees: [] as Row[],
    payments: [] as Row[],
  };

  const relateFee = (f: Row): Row => {
    const m = state.members.find((x) => x.id === f.gymMemberId);
    return {
      ...f,
      plan: f.planId ? (state.plans.find((p) => p.id === f.planId) ?? null) : null,
      gymMember: m ? { ...m, user: state.users.find((u) => u.id === m.userId) ?? null } : null,
      payments: sortRows(
        state.payments.filter((p) => p.memberFeeId === f.id),
        [{ paidAt: 'asc' }, { createdAt: 'asc' }],
      ),
    };
  };

  const models = {
    ...gym.models,
    membershipPlan: {
      findMany: async ({ where, orderBy, take }: Row) => {
        let rows = sortRows(state.plans.filter((p) => matches(p, where)), orderBy);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows;
      },
      findFirst: async ({ where }: Row) => state.plans.find((p) => matches(p, where)) ?? null,
      count: async ({ where }: Row) => state.plans.filter((p) => matches(p, where)).length,
      create: async ({ data }: Row) => {
        const row: Row = {
          id: randomUUID(), description: null, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...data,
        };
        state.plans.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => {
        const row = state.plans.find((p) => p.id === where.id);
        if (!row) throw new Error('Record not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    memberFee: {
      findMany: async ({ where, orderBy, take, cursor, skip }: Row) => {
        let rows = sortRows(state.fees.filter((f) => matches(f, where)), orderBy);
        if (cursor) {
          const i = rows.findIndex((r) => r.id === cursor.id);
          rows = i >= 0 ? rows.slice(i + (skip ?? 0)) : [];
        }
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map(relateFee);
      },
      findFirst: async ({ where }: Row) => {
        const fee = state.fees.find((f) => matches(f, where));
        return fee ? relateFee(fee) : null;
      },
      create: async ({ data }: Row) => {
        const row: Row = {
          id: randomUUID(), planId: null, amountPaid: 0, status: 'PENDING', paidAt: null,
          createdAt: new Date(), updatedAt: new Date(), ...data,
        };
        state.fees.push(row);
        return relateFee(row);
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.fees.filter((f) => matches(f, where));
        for (const fee of hit) Object.assign(fee, data, { updatedAt: new Date() });
        return { count: hit.length };
      },
    },
    feePayment: {
      findMany: async ({ where, orderBy }: Row) => sortRows(state.payments.filter((p) => matches(p, where)), orderBy),
      findFirst: async ({ where, orderBy }: Row) =>
        sortRows(state.payments.filter((p) => matches(p, where)), orderBy)[0] ?? null,
      create: async ({ data }: Row) => {
        if (state.payments.some((p) => p.gymId === data.gymId && p.receiptNo === data.receiptNo)) {
          throw new FakeUniqueError();
        }
        const row: Row = { id: randomUUID(), note: null, createdAt: new Date(), ...data };
        state.payments.push(row);
        return row;
      },
    },
  };

  const tables = (): Row[][] => [
    state.users, state.gyms, state.members, state.subs, state.settings, state.holidays,
    state.consents, state.audits, state.plans, state.fees, state.payments,
  ];

  const prisma = {
    ...models,
    // Rolls every table back IN PLACE (row objects keep their identity) when the callback throws.
    $transaction: async (fn: (tx: typeof models) => Promise<unknown>) => {
      const saved = tables().map((rows) => ({ rows, items: rows.map((row) => ({ row, copy: { ...row } })) }));
      try {
        return await fn(models);
      } catch (error) {
        for (const { rows, items } of saved) {
          rows.splice(0, rows.length, ...items.map((i) => i.row));
          for (const { row, copy } of items) {
            for (const key of Object.keys(row)) if (!(key in copy)) delete row[key];
            Object.assign(row, copy);
          }
        }
        throw error;
      }
    },
  };

  const seed = {
    ...gym.seed,
    plan: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(), gymId: 'g', name: 'Monthly', description: null, durationDays: 30, price: 500,
        isActive: true, createdAt: new Date(), updatedAt: new Date(), ...over,
      };
      state.plans.push(row);
      return row;
    },
    fee: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(), planId: null, periodStart: new Date('2026-11-04T00:00:00.000Z'),
        periodEnd: new Date('2026-12-03T00:00:00.000Z'), dueDate: new Date('2026-11-10T00:00:00.000Z'),
        amount: 500, amountPaid: 0, status: 'PENDING', paidAt: null, createdAt: new Date(), updatedAt: new Date(), ...over,
      };
      state.fees.push(row);
      return row;
    },
    payment: (over: Row = {}): Row => {
      const row: Row = {
        id: randomUUID(), amount: 100, method: 'CASH', receiptNo: 'R-000001', note: null,
        recordedById: 'owner', paidAt: new Date('2026-11-04T10:00:00.000Z'), createdAt: new Date(), ...over,
      };
      state.payments.push(row);
      return row;
    },
  };

  return { prisma, models, state, seed };
}