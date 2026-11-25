import { randomBytes, randomInt } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays } from '../src/common/date-only.js';
import { istDateString } from '../src/common/profile/age.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ALLOWED_TEST_DATABASES } from './support/e2e-env.js';

// The database guard already ran (see test/support/e2e-setup.ts) before this file was loaded.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: INestApplication;
let prisma: PrismaService;
let baseUrl = '';

const tag = randomBytes(3).toString('hex');
const phones: string[] = [];
const uname = (label: string) => `e2e${tag}${label}`;
const today = istDateString();
const day = (n: number) => addDays(today, n);
const MASKED = /^\+91\*+\d{4}$/;
const UNKNOWN_ID = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  const { AppModule } = await import('../src/app.module.js');
  const { PrismaService: PrismaServiceClass } = await import('../src/prisma/prisma.service.js');
  const { createRequestLogger } = await import('../src/common/logging/request-logger.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(createRequestLogger({ log: () => undefined, warn: () => undefined, error: () => undefined }));
  await app.init();
  prisma = app.get(PrismaServiceClass);

  const rows = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
  const connected = rows[0]?.db ?? '(unknown)';
  if (!ALLOWED_TEST_DATABASES.includes(connected)) {
    await app.close();
    throw new Error(`Refusing to run: connected to "${connected}", which is not a test database.`);
  }
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 60_000);

afterAll(async () => {
  try {
    if (prisma) {
      const users = await prisma.user.findMany({ where: { phone: { in: phones } }, select: { id: true } });
      const ids = users.map((u) => u.id);
      // Gym deletion removes memberships, plans, fees and payments through the cascades.
      await prisma.gym.deleteMany({ where: { createdById: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.otpRequest.deleteMany({ where: { phone: { in: phones } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  } finally {
    await app?.close();
  }
});

// ---------------------------------------------------------------- helpers

function newPhone(): string {
  const phone = `+919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  phones.push(phone);
  return phone;
}

async function api(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function signIn(phone = newPhone()): Promise<{ phone: string; token: string; refresh: string }> {
  expect((await api('POST', '/auth/otp/request', { body: { phone } })).status).toBe(200);
  const res = await api('POST', '/auth/otp/verify', { body: { phone, code: '123456', acceptedTerms: true } });
  expect(res.status).toBe(200);
  return { phone, token: res.json.accessToken as string, refresh: res.json.refreshToken as string };
}

function dobFor(ageYears: number): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - ageYears);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

interface Person {
  phone: string;
  token: string;
  refresh: string;
  id: string;
}

async function adult(label: string): Promise<Person> {
  const session = await signIn();
  const res = await api('PUT', '/users/me/profile', {
    token: session.token,
    body: { name: `User ${label}`, username: uname(label), dateOfBirth: dobFor(30) },
  });
  expect(res.status).toBe(200);
  const id = (await prisma.user.findUniqueOrThrow({ where: { phone: session.phone } })).id;
  return { ...session, id };
}

async function createGym(token: string): Promise<Json> {
  const res = await api('POST', '/gyms', {
    token,
    body: { name: `Fees Gym ${tag}`, city: 'Jabalpur', latitude: 23.1815, longitude: 79.9864 },
  });
  expect(res.status).toBe(201);
  return res.json;
}

async function createPlan(owner: Person, gymId: string, over: Json = {}): Promise<Json> {
  const res = await api('POST', `/gyms/${gymId}/plans`, {
    token: owner.token,
    body: { name: 'Monthly', durationDays: 30, price: 500, ...over },
  });
  expect(res.status).toBe(201);
  return res.json;
}

// Joins with the gym code and has the owner approve, so the person is an ACTIVE member.
async function activate(owner: Person, gym: Json, person: Person): Promise<string> {
  const joined = await api('POST', '/gyms/join', { token: person.token, body: { code: gym.code, whatsappConsent: false } });
  expect(joined.status).toBe(200);
  const row = await prisma.gymMember.findFirstOrThrow({ where: { gymId: gym.id, userId: person.id, role: 'MEMBER' } });
  const approved = await api('POST', `/gyms/${gym.id}/join-requests/${row.id}/approve`, { token: owner.token });
  expect(approved.status).toBe(200);
  return row.id;
}

async function enroll(owner: Person, gym: Json, label: string): Promise<{ person: Person; memberId: string }> {
  const person = await adult(label);
  return { person, memberId: await activate(owner, gym, person) };
}

const assign = (owner: Person, gymId: string, memberId: string, body: Json) =>
  api('POST', `/gyms/${gymId}/members/${memberId}/fees`, { token: owner.token, body });
const fees = (token: string, gymId: string, query = '') => api('GET', `/gyms/${gymId}/fees${query}`, { token });
const feeOf = (token: string, gymId: string, feeId: string) => api('GET', `/gyms/${gymId}/fees/${feeId}`, { token });
const pay = (owner: Person, gymId: string, feeId: string, body: Json) =>
  api('POST', `/gyms/${gymId}/fees/${feeId}/payments`, { token: owner.token, body });
const reverse = (owner: Person, gymId: string, feeId: string, paymentId: string, reason = 'Entered the wrong amount') =>
  api('POST', `/gyms/${gymId}/fees/${feeId}/payments/${paymentId}/reverse`, { token: owner.token, body: { reason } });
const waive = (owner: Person, gymId: string, feeId: string, reason = 'Member injured') =>
  api('POST', `/gyms/${gymId}/fees/${feeId}/waive`, { token: owner.token, body: { reason } });
const myFees = (token: string, gymId: string) => api('GET', `/gyms/${gymId}/membership/fees`, { token });
const accept = (token: string, gymId: string, whatsappConsent: unknown) =>
  api('POST', `/gyms/${gymId}/membership/accept`, { token, body: { whatsappConsent } });
const removeMember = (owner: Person, gymId: string, memberId: string) =>
  api('DELETE', `/gyms/${gymId}/members/${memberId}`, { token: owner.token });
const me = (token: string) => api('GET', '/auth/me', { token });
const codes = (res: { json: Json }) => [res.json.code, res.json.details?.map((d: Json) => d.field)];
const ownerRowId = async (gymId: string, userId: string) =>
  (await prisma.gymMember.findFirstOrThrow({ where: { gymId, userId, role: 'OWNER' } })).id;

// ------------------------------------------------------------------ tests

describe('every fees route needs a token', () => {
  it('answers 401 TOKEN_MISSING without one', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const routes: Array<[string, string]> = [
      ['GET', `/gyms/${id}/plans`], ['POST', `/gyms/${id}/plans`], ['PATCH', `/gyms/${id}/plans/${id}`],
      ['POST', `/gyms/${id}/members/${id}/fees`], ['GET', `/gyms/${id}/fees`], ['GET', `/gyms/${id}/fees/${id}`],
      ['POST', `/gyms/${id}/fees/${id}/payments`], ['POST', `/gyms/${id}/fees/${id}/payments/${id}/reverse`],
      ['POST', `/gyms/${id}/fees/${id}/waive`], ['GET', `/gyms/${id}/membership/fees`],
      ['POST', `/gyms/${id}/membership/accept`],
    ];
    for (const [method, path] of routes) {
      const res = await api(method, path, { body: method === 'GET' ? undefined : {} });
      expect([method, path, res.status, res.json.code]).toEqual([method, path, 401, 'TOKEN_MISSING']);
    }
  });
});

describe('membership plans', () => {
  let owner: Person;
  let member: Person;
  let gym: Json;

  beforeAll(async () => {
    owner = await adult('po');
    ({ person: member } = await enroll(owner, (gym = await createGym(owner.token)), 'pm'));
  });

  it('creates a plan, with the price in rupees', async () => {
    const res = await api('POST', `/gyms/${gym.id}/plans`, {
      token: owner.token,
      body: { name: 'Monthly', durationDays: 30, price: 499.5, description: 'All equipment' },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ name: 'Monthly', durationDays: 30, price: 499.5, description: 'All equipment', isActive: true });
    expect(res.json.planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'plan.created' } })).toBe(1);
  });

  it('validates the input', async () => {
    const bad: Json[] = [{ price: 0 }, { price: 10.555 }, { price: 2_000_000 }, { durationDays: 0 }, { durationDays: 400 }, { name: 'A' }];
    for (const over of bad) {
      const res = await api('POST', `/gyms/${gym.id}/plans`, {
        token: owner.token,
        body: { name: 'Another', durationDays: 30, price: 500, ...over },
      });
      expect([JSON.stringify(over), res.status, res.json.code]).toEqual([JSON.stringify(over), 400, 'VALIDATION_FAILED']);
    }
    const empty = await api('POST', `/gyms/${gym.id}/plans`, { token: owner.token, body: {} });
    expect(empty.json.details.map((d: Json) => d.field).sort()).toEqual(['durationDays', 'name', 'price']);
  });

  it('refuses a duplicate name, ignoring case', async () => {
    const res = await api('POST', `/gyms/${gym.id}/plans`, {
      token: owner.token,
      body: { name: 'MONTHLY', durationDays: 30, price: 600 },
    });
    expect([res.status, res.json.code]).toEqual([409, 'PLAN_NAME_TAKEN']);
  });

  it('lists active plans, shortest first, and inactive ones on request; edits and deactivates', async () => {
    const weekly = await createPlan(owner, gym.id, { name: 'Weekly', durationDays: 7, price: 150 });
    const old = await createPlan(owner, gym.id, { name: 'Old', durationDays: 30, price: 400 });

    const edited = await api('PATCH', `/gyms/${gym.id}/plans/${old.planId}`, { token: owner.token, body: { price: 420, isActive: false } });
    expect([edited.status, edited.json.price, edited.json.isActive]).toEqual([200, 420, false]);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'plan.updated' } })).toBe(1);

    const active = await api('GET', `/gyms/${gym.id}/plans`, { token: owner.token });
    expect((active.json.items as Json[]).map((p) => p.name)).toEqual(['Weekly', 'Monthly']);
    const all = await api('GET', `/gyms/${gym.id}/plans?includeInactive=true`, { token: owner.token });
    expect((all.json.items as Json[]).map((p) => p.name)).toEqual(['Weekly', 'Monthly', 'Old']);
    expect((await api('GET', `/gyms/${gym.id}/plans?includeInactive=maybe`, { token: owner.token })).json.code).toBe('VALIDATION_FAILED');

    const clash = await api('PATCH', `/gyms/${gym.id}/plans/${weekly.planId}`, { token: owner.token, body: { name: 'monthly' } });
    expect([clash.status, clash.json.code]).toEqual([409, 'PLAN_NAME_TAKEN']);
    expect((await api('PATCH', `/gyms/${gym.id}/plans/${weekly.planId}`, { token: owner.token, body: {} })).json.code).toBe('VALIDATION_FAILED');
    expect((await api('PATCH', `/gyms/${gym.id}/plans/${weekly.planId}`, { token: owner.token, body: { gymId: 'x' } })).json.code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 for unknown plans, 403 to members and 404 to strangers', async () => {
    const stranger = await adult('ps');
    const unknown = await api('PATCH', `/gyms/${gym.id}/plans/${UNKNOWN_ID}`, { token: owner.token, body: { isActive: false } });
    expect([unknown.status, unknown.json.code]).toEqual([404, 'PLAN_NOT_FOUND']);
    expect((await api('PATCH', `/gyms/${gym.id}/plans/not-a-uuid`, { token: owner.token, body: { isActive: false } })).json.code).toBe('PLAN_NOT_FOUND');

    const asMember = await api('GET', `/gyms/${gym.id}/plans`, { token: member.token });
    expect([asMember.status, asMember.json.code]).toEqual([403, 'GYM_FORBIDDEN']);
    expect((await api('POST', `/gyms/${gym.id}/plans`, { token: member.token, body: { name: 'Sneaky', durationDays: 30, price: 1 } })).json.code).toBe('GYM_FORBIDDEN');
    const asStranger = await api('GET', `/gyms/${gym.id}/plans`, { token: stranger.token });
    expect([asStranger.status, asStranger.json.code]).toEqual([404, 'GYM_NOT_FOUND']);
  });
});

describe('assigning fees', () => {
  let owner: Person;
  let gym: Json;
  let plan: Json;

  beforeAll(async () => {
    owner = await adult('ao');
    gym = await createGym(owner.token);
    plan = await createPlan(owner, gym.id);
  });

  it('creates a cycle that ends after the plan duration and is due on the start date by default', async () => {
    const { person, memberId } = await enroll(owner, gym, 'a1');
    const res = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      memberId, periodStart: today, periodEnd: day(29), dueDate: today, amount: 500, amountPaid: 0, balance: 500,
      waivedAmount: 0, status: 'PENDING', plan: { planId: plan.planId, name: 'Monthly' }, payments: [],
    });
    expect(res.json.member).toMatchObject({ name: 'User a1', status: 'ACTIVE', phone: person.phone });

    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: res.json.feeId } });
    expect([Number(row.amount), row.status, row.planId]).toEqual([500, 'PENDING', plan.planId]);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'fee.assigned', entityId: res.json.feeId } })).toBe(1);
  });

  it('accepts a later due date, refuses overlaps, and allows renewals and earlier cycles', async () => {
    const { memberId } = await enroll(owner, gym, 'a2');
    const first = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, dueDate: day(7) });
    expect([first.status, first.json.dueDate]).toEqual([201, day(7)]);

    const overlap = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: day(29) });
    expect([overlap.status, overlap.json.code]).toEqual([409, 'FEE_PERIOD_OVERLAP']);

    const renewal = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: day(30) });
    expect(renewal.json).toMatchObject({ periodStart: day(30), periodEnd: day(59) });

    const earlier = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: day(-30) });
    expect(earlier.status).toBe(201);
    expect(earlier.json.status).toBe('OVERDUE'); // due on its start date, which has passed
  });

  it('needs a reason for a different amount, and keeps the reason in the audit log', async () => {
    const { memberId } = await enroll(owner, gym, 'a3');
    const noReason = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, amount: 400 });
    expect(codes(noReason)).toEqual(['VALIDATION_FAILED', ['amountReason']]);

    const res = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, amount: 400, amountReason: 'Student discount' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ amount: 400, balance: 400 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: res.json.feeId, action: 'fee.assigned' } });
    expect(audit.metadata).toMatchObject({ amount: 400, planPrice: 500, reason: 'Student discount' });

    const other = await enroll(owner, gym, 'a3b');
    const same = await assign(owner, gym.id, other.memberId, { planId: plan.planId, startDate: today, amount: 500 });
    expect([same.status, same.json.amount]).toEqual([201, 500]);
  });

  it('validates the input', async () => {
    const { memberId } = await enroll(owner, gym, 'a4');
    const base = { planId: plan.planId, startDate: today };
    const bad: Array<[Json, string]> = [
      [{ ...base, planId: 'x' }, 'planId'],
      [{ ...base, startDate: '2026-02-30' }, 'startDate'],
      [{ ...base, amount: 0 }, 'amount'],
      [{ ...base, amount: 10.555 }, 'amount'],
      [{ ...base, startDate: day(-91) }, 'startDate'],
      [{ ...base, startDate: day(366) }, 'startDate'],
      [{ ...base, dueDate: day(-31) }, 'dueDate'],
      [{ ...base, dueDate: day(30) }, 'dueDate'],
    ];
    for (const [body, field] of bad) {
      const res = await assign(owner, gym.id, memberId, body);
      expect([JSON.stringify(body), res.status, res.json.code, res.json.details?.[0]?.field]).toEqual([JSON.stringify(body), 400, 'VALIDATION_FAILED', field]);
    }
    const empty = await assign(owner, gym.id, memberId, {});
    expect(empty.json.details.map((d: Json) => d.field).sort()).toEqual(['planId', 'startDate']);
  });

  it('refuses unknown, inactive and foreign plans', async () => {
    const { memberId } = await enroll(owner, gym, 'a5');
    const body = { startDate: today };
    expect((await assign(owner, gym.id, memberId, { ...body, planId: UNKNOWN_ID })).json.code).toBe('PLAN_NOT_FOUND');

    const stranger = await adult('ax');
    const foreignGym = await createGym(stranger.token);
    const foreignPlan = await createPlan(stranger, foreignGym.id);
    expect((await assign(owner, gym.id, memberId, { ...body, planId: foreignPlan.planId })).json.code).toBe('PLAN_NOT_FOUND');

    const retired = await createPlan(owner, gym.id, { name: 'Retired' });
    await api('PATCH', `/gyms/${gym.id}/plans/${retired.planId}`, { token: owner.token, body: { isActive: false } });
    const res = await assign(owner, gym.id, memberId, { ...body, planId: retired.planId });
    expect([res.status, res.json.code]).toEqual([409, 'PLAN_INACTIVE']);
  });

  it('bills active and invited members, but not pending or removed ones, and 404s on unknown members', async () => {
    const body = { planId: plan.planId, startDate: today };

    const invitedPhone = newPhone();
    const added = await api('POST', `/gyms/${gym.id}/members`, { token: owner.token, body: { name: 'Invited Person', phone: invitedPhone } });
    expect(added.status).toBe(201);
    const billed = await assign(owner, gym.id, added.json.memberId, body);
    expect([billed.status, billed.json.member.status]).toEqual([201, 'INVITED']);

    const pending = await adult('a6');
    await api('POST', '/gyms/join', { token: pending.token, body: { code: gym.code, whatsappConsent: false } });
    const pendingRow = await prisma.gymMember.findFirstOrThrow({ where: { gymId: gym.id, userId: pending.id, role: 'MEMBER' } });
    expect((await assign(owner, gym.id, pendingRow.id, body)).json.code).toBe('MEMBER_NOT_BILLABLE');

    const removed = await enroll(owner, gym, 'a6b');
    expect((await removeMember(owner, gym.id, removed.memberId)).status).toBe(204);
    const refused = await assign(owner, gym.id, removed.memberId, body);
    expect([refused.status, refused.json.code]).toEqual([409, 'MEMBER_NOT_BILLABLE']);

    for (const id of [UNKNOWN_ID, 'not-a-uuid', await ownerRowId(gym.id, owner.id)]) {
      expect((await assign(owner, gym.id, id, body)).json.code).toBe('MEMBER_NOT_FOUND');
    }
  });

  it('is for owners only', async () => {
    const one = await enroll(owner, gym, 'a7');
    const other = await enroll(owner, gym, 'a7b');
    const stranger = await adult('a7c');
    const body = { planId: plan.planId, startDate: today };
    const asMember = await api('POST', `/gyms/${gym.id}/members/${one.memberId}/fees`, { token: other.person.token, body });
    expect([asMember.status, asMember.json.code]).toEqual([403, 'GYM_FORBIDDEN']);
    const asStranger = await api('POST', `/gyms/${gym.id}/members/${one.memberId}/fees`, { token: stranger.token, body });
    expect([asStranger.status, asStranger.json.code]).toEqual([404, 'GYM_NOT_FOUND']);
  });
});

describe('payments and receipts', () => {
  let owner: Person;
  let gym: Json;
  let plan: Json;
  let first: { person: Person; memberId: string };
  let fee: Json;

  beforeAll(async () => {
    owner = await adult('yo');
    gym = await createGym(owner.token);
    plan = await createPlan(owner, gym.id);
    first = await enroll(owner, gym, 'ym');
    fee = (await assign(owner, gym.id, first.memberId, { planId: plan.planId, startDate: today, dueDate: day(7) })).json;
  });

  it('records a partial payment: receipt R-000001, PARTIAL status, reduced balance', async () => {
    const res = await pay(owner, gym.id, fee.feeId, { amount: 200, method: 'CASH', note: 'Paid at the desk' });
    expect(res.status).toBe(201);
    expect(res.json.payment).toMatchObject({
      receiptNo: 'R-000001', kind: 'PAYMENT', amount: 200, method: 'CASH', note: 'Paid at the desk', reversed: false, recordedById: owner.id,
    });
    expect(res.json.fee).toMatchObject({ amountPaid: 200, balance: 300, status: 'PARTIAL', paidAt: null });

    const payments = await prisma.feePayment.findMany({ where: { memberFeeId: fee.feeId } });
    expect(payments.map((p) => [p.receiptNo, Number(p.amount)])).toEqual([['R-000001', 200]]);
    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: fee.feeId } });
    expect([Number(row.amountPaid), row.status]).toEqual([200, 'PARTIAL']);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'fee.payment_recorded' } })).toBe(1);
  });

  it('refuses overpaying and invalid amounts or methods, and records nothing', async () => {
    const over = await pay(owner, gym.id, fee.feeId, { amount: 300.01, method: 'CASH' });
    expect([over.status, over.json.code]).toEqual([409, 'PAYMENT_EXCEEDS_BALANCE']);
    expect(codes(await pay(owner, gym.id, fee.feeId, { amount: 10.555, method: 'CASH' }))).toEqual(['VALIDATION_FAILED', ['amount']]);
    expect((await pay(owner, gym.id, fee.feeId, { amount: 0, method: 'CASH' })).json.code).toBe('VALIDATION_FAILED');
    expect(codes(await pay(owner, gym.id, fee.feeId, { amount: 100, method: 'BITCOIN' }))).toEqual(['VALIDATION_FAILED', ['method']]);
    const empty = await pay(owner, gym.id, fee.feeId, {});
    expect(empty.json.details.map((d: Json) => d.field).sort()).toEqual(['amount', 'method']);
    expect(await prisma.feePayment.count({ where: { memberFeeId: fee.feeId } })).toBe(1);
  });

  it('refuses payment dates in the future or more than 30 days back, and accepts a recent date', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    for (const paidAt of [future, day(-31), 'yesterday']) {
      const res = await pay(owner, gym.id, fee.feeId, { amount: 100, method: 'CASH', paidAt });
      expect([paidAt, res.status, res.json.code, res.json.details?.[0]?.field]).toEqual([paidAt, 400, 'VALIDATION_FAILED', 'paidAt']);
    }
    const ok = await pay(owner, gym.id, fee.feeId, { amount: 100, method: 'UPI', paidAt: day(-3) });
    expect(ok.status).toBe(201);
    expect(ok.json.payment).toMatchObject({ receiptNo: 'R-000002', method: 'UPI' });
    expect(String(ok.json.payment.paidAt).slice(0, 10)).toBe(day(-3));
    expect(ok.json.fee).toMatchObject({ amountPaid: 300, balance: 200, status: 'PARTIAL' });
  });

  it('completes the fee with the last payment, and refuses more', async () => {
    const res = await pay(owner, gym.id, fee.feeId, { amount: 200, method: 'UPI' });
    expect(res.json.payment.receiptNo).toBe('R-000003');
    expect(res.json.fee).toMatchObject({ amountPaid: 500, balance: 0, status: 'PAID' });
    expect(res.json.fee.paidAt).not.toBeNull();

    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: fee.feeId } });
    expect([Number(row.amountPaid), row.status]).toEqual([500, 'PAID']);

    const more = await pay(owner, gym.id, fee.feeId, { amount: 1, method: 'CASH' });
    expect([more.status, more.json.code]).toEqual([409, 'FEE_ALREADY_PAID']);
  });

  it('shows every payment on the fee, and the fee in the right lists', async () => {
    const detail = await feeOf(owner.token, gym.id, fee.feeId);
    expect(detail.status).toBe(200);
    expect((detail.json.payments as Json[]).map((p) => p.receiptNo)).toEqual(['R-000002', 'R-000001', 'R-000003']); // by payment date
    expect(detail.json.payments.every((p: Json) => p.kind === 'PAYMENT' && p.reversed === false)).toBe(true);

    const paid = await fees(owner.token, gym.id, '?status=PAID');
    expect((paid.json.items as Json[]).map((i) => i.feeId)).toContain(fee.feeId);
    const partial = await fees(owner.token, gym.id, '?status=partial');
    expect((partial.json.items as Json[]).map((i) => i.feeId)).not.toContain(fee.feeId);
  });

  it('numbers receipts in sequence across fees in the gym', async () => {
    const second = await enroll(owner, gym, 'y2');
    const secondFee = (await assign(owner, gym.id, second.memberId, { planId: plan.planId, startDate: today })).json;
    const res = await pay(owner, gym.id, secondFee.feeId, { amount: 100, method: 'CARD' });
    expect(res.json.payment.receiptNo).toBe('R-000004');
  });

  it('shows members only their own fees and receipts', async () => {
    const mine = await myFees(first.person.token, gym.id);
    expect(mine.status).toBe(200);
    expect(mine.json.items).toHaveLength(1);
    expect(mine.json.items[0]).toMatchObject({ feeId: fee.feeId, status: 'PAID', amount: 500, balance: 0 });
    expect(mine.json.items[0].payments).toHaveLength(3);
    expect('member' in mine.json.items[0]).toBe(false);

    const other = await enroll(owner, gym, 'y3');
    const otherFee = await assign(owner, gym.id, other.memberId, { planId: plan.planId, startDate: today });
    const theirs = await myFees(other.person.token, gym.id);
    expect((theirs.json.items as Json[]).map((i) => i.feeId)).toEqual([otherFee.json.feeId]);
    expect(theirs.text).not.toContain(first.person.phone);

    const asOwner = await myFees(owner.token, gym.id);
    expect([asOwner.status, asOwner.json.code]).toEqual([404, 'MEMBERSHIP_NOT_FOUND']);
    const stranger = await adult('y4');
    expect((await myFees(stranger.token, gym.id)).json.code).toBe('GYM_NOT_FOUND');
  });

  it('keeps money exact to the paisa', async () => {
    const odd = await createPlan(owner, gym.id, { name: 'Odd', durationDays: 30, price: 499.99 });
    const { memberId } = await enroll(owner, gym, 'y5');
    const oddFee = (await assign(owner, gym.id, memberId, { planId: odd.planId, startDate: today })).json;
    expect(oddFee.amount).toBe(499.99);

    const one = await pay(owner, gym.id, oddFee.feeId, { amount: 100.1, method: 'CASH' });
    expect(one.json.fee).toMatchObject({ amountPaid: 100.1, balance: 399.89, status: 'PARTIAL' });
    const two = await pay(owner, gym.id, oddFee.feeId, { amount: 399.89, method: 'CASH' });
    expect(two.json.fee).toMatchObject({ amountPaid: 499.99, balance: 0, status: 'PAID' });

    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: oddFee.feeId } });
    expect([row.amount.toString(), row.amountPaid.toString()]).toEqual(['499.99', '499.99']);
  });

  it('handles two simultaneous payments safely: exactly one wins', async () => {
    const { memberId } = await enroll(owner, gym, 'y6');
    const raceFee = (await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today })).json;

    const results = await Promise.all([
      pay(owner, gym.id, raceFee.feeId, { amount: 300, method: 'CASH' }),
      pay(owner, gym.id, raceFee.feeId, { amount: 300, method: 'CASH' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(['FEE_CHANGED', 'PAYMENT_EXCEEDS_BALANCE']).toContain(loser.json.code);

    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: raceFee.feeId } });
    expect(Number(row.amountPaid)).toBe(300);
    expect(await prisma.feePayment.count({ where: { memberFeeId: raceFee.feeId } })).toBe(1);
  });
});

describe('reversals', () => {
  let owner: Person;
  let gym: Json;
  let plan: Json;
  let member: { person: Person; memberId: string };
  let fee: Json;
  let p1: Json;
  let p2: Json;

  beforeAll(async () => {
    owner = await adult('ro');
    gym = await createGym(owner.token);
    plan = await createPlan(owner, gym.id);
    member = await enroll(owner, gym, 'r1');
    fee = (await assign(owner, gym.id, member.memberId, { planId: plan.planId, startDate: today, dueDate: day(7) })).json;
    p1 = (await pay(owner, gym.id, fee.feeId, { amount: 300, method: 'CASH' })).json.payment;
    p2 = (await pay(owner, gym.id, fee.feeId, { amount: 200, method: 'UPI' })).json.payment;
  });

  it('reverses a payment with a reason: a negative X- entry, and the fee is recalculated', async () => {
    const res = await reverse(owner, gym.id, fee.feeId, p2.paymentId, 'Entered the wrong amount');
    expect(res.status).toBe(201);
    expect(res.json.payment).toMatchObject({
      receiptNo: 'X-000001', kind: 'REVERSAL', amount: -200, method: 'UPI', reversesReceiptNo: 'R-000002',
      note: 'REVERSAL OF R-000002: Entered the wrong amount', recordedById: owner.id,
    });
    expect(res.json.fee).toMatchObject({ amountPaid: 300, balance: 200, status: 'PARTIAL', paidAt: null });
    expect((res.json.fee.payments as Json[]).map((p) => [p.receiptNo, p.reversed])).toEqual([
      ['R-000001', false], ['R-000002', true], ['X-000001', false],
    ]);

    const rows = await prisma.feePayment.findMany({ where: { memberFeeId: fee.feeId }, orderBy: { receiptNo: 'asc' } });
    expect(rows.map((r) => [r.receiptNo, Number(r.amount)])).toEqual([['R-000001', 300], ['R-000002', 200], ['X-000001', -200]]);
    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: fee.feeId } });
    expect([Number(row.amountPaid), row.status]).toEqual([300, 'PARTIAL']);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'fee.payment_reversed' } })).toBe(1);
  });

  it('refuses a second reversal, reversing a reversal, a short reason, and unknown payments', async () => {
    const again = await reverse(owner, gym.id, fee.feeId, p2.paymentId);
    expect([again.status, again.json.code]).toEqual([409, 'PAYMENT_ALREADY_REVERSED']);

    const entry = (await feeOf(owner.token, gym.id, fee.feeId)).json.payments.find((p: Json) => p.kind === 'REVERSAL');
    const ofEntry = await reverse(owner, gym.id, fee.feeId, entry.paymentId);
    expect([ofEntry.status, ofEntry.json.code]).toEqual([409, 'PAYMENT_NOT_REVERSIBLE']);

    expect(codes(await reverse(owner, gym.id, fee.feeId, p1.paymentId, 'no'))).toEqual(['VALIDATION_FAILED', ['reason']]);
    expect((await reverse(owner, gym.id, fee.feeId, UNKNOWN_ID)).json.code).toBe('PAYMENT_NOT_FOUND');
    expect((await reverse(owner, gym.id, fee.feeId, 'not-a-uuid')).json.code).toBe('PAYMENT_NOT_FOUND');

    const other = await enroll(owner, gym, 'r2');
    const otherFee = (await assign(owner, gym.id, other.memberId, { planId: plan.planId, startDate: today })).json;
    const otherPayment = (await pay(owner, gym.id, otherFee.feeId, { amount: 100, method: 'CASH' })).json.payment;
    const foreign = await reverse(owner, gym.id, fee.feeId, otherPayment.paymentId);
    expect([foreign.status, foreign.json.code]).toEqual([404, 'PAYMENT_NOT_FOUND']);
    expect(await prisma.feePayment.count({ where: { gymId: gym.id, receiptNo: { startsWith: 'X-' } } })).toBe(1);
  });

  it('lets the balance be paid again after a reversal', async () => {
    const res = await pay(owner, gym.id, fee.feeId, { amount: 200, method: 'CASH' });
    expect(res.status).toBe(201);
    expect(res.json.payment.receiptNo).toMatch(/^R-\d{6}$/);
    expect(res.json.fee).toMatchObject({ amountPaid: 500, balance: 0, status: 'PAID' });
  });

  it('returns a fee to PENDING when all its payments are reversed, with its own X sequence', async () => {
    const { memberId } = await enroll(owner, gym, 'r3');
    const f = (await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, dueDate: day(7) })).json;
    const paid = await pay(owner, gym.id, f.feeId, { amount: 500, method: 'CARD' });
    expect(paid.json.fee.status).toBe('PAID');

    const res = await reverse(owner, gym.id, f.feeId, paid.json.payment.paymentId, 'Card was declined');
    expect(res.json.payment.receiptNo).toBe('X-000002');
    expect(res.json.fee).toMatchObject({ amountPaid: 0, balance: 500, status: 'PENDING', paidAt: null });
  });

  it('shows reversal entries to the member', async () => {
    const mine = await myFees(member.person.token, gym.id);
    const payments = mine.json.items[0].payments as Json[];
    expect(payments.some((p) => p.kind === 'REVERSAL' && p.amount === -200 && p.reversesReceiptNo === 'R-000002')).toBe(true);
    expect(payments.find((p) => p.receiptNo === 'R-000002')).toMatchObject({ reversed: true });
  });
});

describe('waiving fees', () => {
  let owner: Person;
  let gym: Json;
  let plan: Json;

  beforeAll(async () => {
    owner = await adult('vo');
    gym = await createGym(owner.token);
    plan = await createPlan(owner, gym.id);
  });

  const newFee = async (label: string, over: Json = {}) => {
    const { memberId } = await enroll(owner, gym, label);
    const res = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, dueDate: day(7), ...over });
    expect(res.status).toBe(201);
    return { memberId, feeId: res.json.feeId as string };
  };

  it('waives an unpaid fee: the whole amount is forgiven, and the reason is audited', async () => {
    const { feeId } = await newFee('v1');
    const res = await waive(owner, gym.id, feeId, 'Member injured');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'WAIVED', balance: 0, waivedAmount: 500, amountPaid: 0 });

    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: feeId } });
    expect(row.status).toBe('WAIVED');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: feeId, action: 'fee.waived' } });
    expect(audit.metadata).toMatchObject({ waivedAmount: 500, reason: 'Member injured' });
  });

  it('is final: no payments, no second waive', async () => {
    const { feeId } = await newFee('v2');
    await waive(owner, gym.id, feeId);
    const payment = await pay(owner, gym.id, feeId, { amount: 100, method: 'CASH' });
    expect([payment.status, payment.json.code]).toEqual([409, 'FEE_WAIVED']);
    const again = await waive(owner, gym.id, feeId);
    expect([again.status, again.json.code]).toEqual([409, 'FEE_ALREADY_WAIVED']);
  });

  it('lets the same days be billed again, because waived cycles do not count', async () => {
    const { memberId, feeId } = await newFee('v3');
    expect((await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today })).json.code).toBe('FEE_PERIOD_OVERLAP');
    await waive(owner, gym.id, feeId);
    const again = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today });
    expect(again.status).toBe(201);
  });

  it('keeps what was already paid, and then blocks reversals', async () => {
    const { feeId } = await newFee('v4');
    const payment = (await pay(owner, gym.id, feeId, { amount: 200, method: 'CASH' })).json.payment;
    const res = await waive(owner, gym.id, feeId);
    expect(res.json).toMatchObject({ status: 'WAIVED', amountPaid: 200, balance: 0, waivedAmount: 300 });
    const reversal = await reverse(owner, gym.id, feeId, payment.paymentId);
    expect([reversal.status, reversal.json.code]).toEqual([409, 'FEE_WAIVED']);
  });

  it('refuses fully paid fees and missing reasons', async () => {
    const { feeId } = await newFee('v5');
    expect(codes(await api('POST', `/gyms/${gym.id}/fees/${feeId}/waive`, { token: owner.token, body: { reason: 'no' } }))).toEqual(['VALIDATION_FAILED', ['reason']]);
    expect(codes(await api('POST', `/gyms/${gym.id}/fees/${feeId}/waive`, { token: owner.token, body: {} }))).toEqual(['VALIDATION_FAILED', ['reason']]);

    await pay(owner, gym.id, feeId, { amount: 500, method: 'CASH' });
    const res = await waive(owner, gym.id, feeId);
    expect([res.status, res.json.code]).toEqual([409, 'FEE_ALREADY_PAID']);
  });
});

describe('listing fees', () => {
  let owner: Person;
  let gym: Json;
  let plan: Json;
  type Cycle = { person: Person; memberId: string; feeId: string };
  let overdue: Cycle;
  let waived: Cycle;
  let paid: Cycle;
  let pending: Cycle;
  let partial: Cycle;

  beforeAll(async () => {
    owner = await adult('lo');
    gym = await createGym(owner.token);
    plan = await createPlan(owner, gym.id);
    const make = async (label: string, body: Json): Promise<Cycle> => {
      const { person, memberId } = await enroll(owner, gym, label);
      const res = await assign(owner, gym.id, memberId, { planId: plan.planId, ...body });
      expect(res.status).toBe(201);
      return { person, memberId, feeId: res.json.feeId as string };
    };
    overdue = await make('l1', { startDate: day(-40), dueDate: day(-20) });
    waived = await make('l2', { startDate: today, dueDate: day(1) });
    paid = await make('l3', { startDate: today, dueDate: day(2) });
    pending = await make('l4', { startDate: today, dueDate: day(5) });
    partial = await make('l5', { startDate: today, dueDate: day(8) });
    expect((await waive(owner, gym.id, waived.feeId)).status).toBe(200);
    expect((await pay(owner, gym.id, paid.feeId, { amount: 500, method: 'CASH' })).status).toBe(201);
    expect((await pay(owner, gym.id, partial.feeId, { amount: 100, method: 'UPI' })).status).toBe(201);
  });

  const ids = (res: { json: Json }) => (res.json.items as Json[]).map((i) => i.feeId);

  it('lists fees by due date, oldest first, with the effective status', async () => {
    const res = await fees(owner.token, gym.id);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([overdue, waived, paid, pending, partial].map((c) => c.feeId));
    expect((res.json.items as Json[]).map((i) => i.status)).toEqual(['OVERDUE', 'WAIVED', 'PAID', 'PENDING', 'PARTIAL']);
    expect(res.json.items[0]).toMatchObject({ balance: 500, memberId: overdue.memberId });
    expect(res.json.nextCursor).toBeNull();
  });

  it('filters by status, in any case', async () => {
    const by = async (status: string) => ids(await fees(owner.token, gym.id, `?status=${status}`));
    expect(await by('OVERDUE')).toEqual([overdue.feeId]);
    expect(await by('waived')).toEqual([waived.feeId]);
    expect(await by('Paid')).toEqual([paid.feeId]);
    expect(await by('PENDING')).toEqual([pending.feeId]);
    expect(await by('partial')).toEqual([partial.feeId]);
  });

  it('filters by member and by due-date range', async () => {
    expect(ids(await fees(owner.token, gym.id, `?memberId=${pending.memberId}`))).toEqual([pending.feeId]);
    expect(ids(await fees(owner.token, gym.id, `?dueFrom=${day(1)}&dueTo=${day(5)}`))).toEqual([waived, paid, pending].map((c) => c.feeId));
    expect(ids(await fees(owner.token, gym.id, `?dueFrom=${day(6)}`))).toEqual([partial.feeId]);
    expect(ids(await fees(owner.token, gym.id, `?status=OVERDUE&dueFrom=${day(-10)}`))).toEqual([]);
  });

  it('pages through every fee exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await fees(owner.token, gym.id, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...ids(res));
      cursor = res.json.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual([overdue, waived, paid, pending, partial].map((c) => c.feeId));
  });

  it('rejects bad query parameters, and a cursor from nowhere', async () => {
    const bad = ['?status=GONE', '?memberId=nope', '?cursor=nope', '?limit=0', '?limit=101', '?dueFrom=soon', `?dueFrom=${day(5)}&dueTo=${day(1)}`, `?cursor=${UNKNOWN_ID}`];
    for (const query of bad) {
      const res = await fees(owner.token, gym.id, query);
      expect([query, res.status, res.json.code]).toEqual([query, 400, 'VALIDATION_FAILED']);
    }
  });

  it('keeps open fees of removed members payable, with their phone masked and no new cycles', async () => {
    const { person, memberId } = await enroll(owner, gym, 'l6');
    const res = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, dueDate: day(9) });
    const feeId = res.json.feeId as string;
    expect((await removeMember(owner, gym.id, memberId)).status).toBe(204);

    const listed = await fees(owner.token, gym.id, `?memberId=${memberId}`);
    expect(listed.json.items[0].member).toMatchObject({ phone: null, status: 'REMOVED' });
    expect(listed.json.items[0].member.phoneMasked).toMatch(MASKED);
    expect(listed.text).not.toContain(person.phone);

    expect((await pay(owner, gym.id, feeId, { amount: 100, method: 'CASH' })).status).toBe(201);
    const next = await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: day(30) });
    expect([next.status, next.json.code]).toEqual([409, 'MEMBER_NOT_BILLABLE']);
    expect((await myFees(person.token, gym.id)).json.code).toBe('GYM_NOT_FOUND');
  });

  it('keeps an overdue fee overdue until it is paid in full', async () => {
    const part = await pay(owner, gym.id, overdue.feeId, { amount: 200, method: 'CASH' });
    expect(part.json.fee).toMatchObject({ status: 'OVERDUE', balance: 300, amountPaid: 200 });
    const rest = await pay(owner, gym.id, overdue.feeId, { amount: 300, method: 'CASH' });
    expect(rest.json.fee).toMatchObject({ status: 'PAID', balance: 0 });
    expect(ids(await fees(owner.token, gym.id, '?status=OVERDUE'))).toEqual([]);
  });
});

describe('who may use the owner routes', () => {
  it('lets only the owner in; members get 403, strangers get 404, and other gyms’ ids are unknown', async () => {
    const owner = await adult('wo');
    const other = await adult('wx');
    const stranger = await adult('ws');
    const gym = await createGym(owner.token);
    const otherGym = await createGym(other.token);
    const plan = await createPlan(owner, gym.id);
    const { person, memberId } = await enroll(owner, gym, 'wm');
    const fee = (await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today })).json;
    const payment = (await pay(owner, gym.id, fee.feeId, { amount: 100, method: 'CASH' })).json.payment;

    const routes: Array<[string, string, Json | undefined]> = [
      ['GET', `/gyms/${gym.id}/plans`, undefined],
      ['POST', `/gyms/${gym.id}/plans`, { name: 'Sneaky', durationDays: 30, price: 1 }],
      ['GET', `/gyms/${gym.id}/fees`, undefined],
      ['GET', `/gyms/${gym.id}/fees/${fee.feeId}`, undefined],
      ['POST', `/gyms/${gym.id}/members/${memberId}/fees`, { planId: plan.planId, startDate: day(60) }],
      ['POST', `/gyms/${gym.id}/fees/${fee.feeId}/payments`, { amount: 100, method: 'CASH' }],
      ['POST', `/gyms/${gym.id}/fees/${fee.feeId}/payments/${payment.paymentId}/reverse`, { reason: 'Sneaky reversal' }],
      ['POST', `/gyms/${gym.id}/fees/${fee.feeId}/waive`, { reason: 'Sneaky waiver' }],
    ];
    for (const [method, path, body] of routes) {
      const asMember = await api(method, path, { token: person.token, body });
      expect([method, path, asMember.status, asMember.json.code]).toEqual([method, path, 403, 'GYM_FORBIDDEN']);
      const asStranger = await api(method, path, { token: stranger.token, body });
      expect([method, path, asStranger.status, asStranger.json.code]).toEqual([method, path, 404, 'GYM_NOT_FOUND']);
    }

    const foreign: Array<[string, string, Json | undefined, string]> = [
      ['GET', `/gyms/${otherGym.id}/fees/${fee.feeId}`, undefined, 'FEE_NOT_FOUND'],
      ['POST', `/gyms/${otherGym.id}/fees/${fee.feeId}/payments`, { amount: 100, method: 'CASH' }, 'FEE_NOT_FOUND'],
      ['POST', `/gyms/${otherGym.id}/fees/${fee.feeId}/payments/${payment.paymentId}/reverse`, { reason: 'Foreign gym' }, 'FEE_NOT_FOUND'],
      ['POST', `/gyms/${otherGym.id}/fees/${fee.feeId}/waive`, { reason: 'Foreign gym' }, 'FEE_NOT_FOUND'],
      ['PATCH', `/gyms/${otherGym.id}/plans/${plan.planId}`, { isActive: false }, 'PLAN_NOT_FOUND'],
      ['POST', `/gyms/${otherGym.id}/members/${memberId}/fees`, { planId: plan.planId, startDate: today }, 'MEMBER_NOT_FOUND'],
    ];
    for (const [method, path, body, code] of foreign) {
      const res = await api(method, path, { token: other.token, body });
      expect([method, path, res.status, res.json.code]).toEqual([method, path, 404, code]);
    }
    expect((await myFees(owner.token, gym.id)).json.code).toBe('MEMBERSHIP_NOT_FOUND');
    expect((await myFees(stranger.token, gym.id)).json.code).toBe('GYM_NOT_FOUND');
  });
});

describe('accepting an invitation', () => {
  let owner: Person;
  let gym: Json;
  let person: Person;
  let rowId: string;

  beforeAll(async () => {
    owner = await adult('io');
    gym = await createGym(owner.token);
    ({ person, memberId: rowId } = await enroll(owner, gym, 'ip'));
  });

  it('has nothing to accept for active members, strangers, pending people and unknown gyms', async () => {
    const already = await accept(person.token, gym.id, true);
    expect([already.status, already.json.code]).toEqual([409, 'ALREADY_MEMBER']);

    const stranger = await adult('iq');
    const none = await accept(stranger.token, gym.id, true);
    expect([none.status, none.json.code]).toEqual([404, 'INVITATION_NOT_FOUND']);

    await api('POST', '/gyms/join', { token: stranger.token, body: { code: gym.code, whatsappConsent: false } });
    expect((await accept(stranger.token, gym.id, true)).json.code).toBe('INVITATION_NOT_FOUND');

    expect((await accept(person.token, UNKNOWN_ID, true)).json.code).toBe('INVITATION_NOT_FOUND');
    expect((await accept(person.token, 'not-a-uuid', true)).json.code).toBe('INVITATION_NOT_FOUND');
    expect(codes(await accept(person.token, gym.id, 'yes'))).toEqual(['VALIDATION_FAILED', ['whatsappConsent']]);
    expect(codes(await api('POST', `/gyms/${gym.id}/membership/accept`, { token: person.token, body: {} }))).toEqual(['VALIDATION_FAILED', ['whatsappConsent']]);
  });

  it('has nothing to accept for a removed person until the owner re-adds them', async () => {
    expect((await removeMember(owner, gym.id, rowId)).status).toBe(204);
    const res = await accept(person.token, gym.id, true);
    expect([res.status, res.json.code]).toEqual([404, 'INVITATION_NOT_FOUND']);
    expect((await api('GET', `/gyms/${gym.id}`, { token: person.token })).json.code).toBe('GYM_NOT_FOUND');
  });

  it('lets the re-added person accept without a gym code, and become active again', async () => {
    const readded = await api('POST', `/gyms/${gym.id}/members`, { token: owner.token, body: { name: 'Back Again', phone: person.phone } });
    expect(readded.status).toBe(201);
    expect(readded.json).toMatchObject({ memberId: rowId, status: 'INVITED', registered: true, whatsappConsent: false });
    expect((await me(person.token)).json.gyms).toEqual([{ gymId: gym.id, gymName: gym.name, role: 'MEMBER', status: 'INVITED' }]);
    expect((await api('GET', `/gyms/${gym.id}`, { token: person.token })).json.code).toBe('GYM_NOT_FOUND');

    const res = await accept(person.token, gym.id, true);
    expect([res.status, res.json]).toEqual([200, { gymId: gym.id, gymName: gym.name, status: 'ACTIVE' }]);
    expect((await api('GET', `/gyms/${gym.id}`, { token: person.token })).status).toBe(200);

    const row = await prisma.gymMember.findUniqueOrThrow({ where: { id: rowId } });
    expect(row).toMatchObject({ status: 'ACTIVE', whatsappConsent: true, removedAt: null });
    expect(row.whatsappConsentAt).not.toBeNull();
    expect(await prisma.consentRecord.count({ where: { userId: person.id, gymId: gym.id, type: 'WHATSAPP', revokedAt: null } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { gymId: gym.id, action: 'gym_member.invitation_accepted', entityId: rowId } })).toBe(1);

    const again = await accept(person.token, gym.id, true);
    expect([again.status, again.json.code]).toEqual([409, 'ALREADY_MEMBER']);
  });

  it('can be billed after accepting, and sees the fee', async () => {
    const plan = await createPlan(owner, gym.id);
    const res = await assign(owner, gym.id, rowId, { planId: plan.planId, startDate: today });
    expect(res.status).toBe(201);
    const mine = await myFees(person.token, gym.id);
    expect((mine.json.items as Json[]).map((i) => i.feeId)).toEqual([res.json.feeId]);
  });

  it('is blocked in a read-only gym, and works again afterwards', async () => {
    const { person: p2, memberId } = await enroll(owner, gym, 'ir');
    await removeMember(owner, gym.id, memberId);
    await api('POST', `/gyms/${gym.id}/members`, { token: owner.token, body: { name: 'Second Return', phone: p2.phone } });

    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'READ_ONLY' } });
    const blocked = await accept(p2.token, gym.id, false);
    expect([blocked.status, blocked.json.code]).toEqual([403, 'GYM_READ_ONLY']);
    expect((await prisma.gymMember.findUniqueOrThrow({ where: { id: memberId } })).status).toBe('INVITED');

    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'TRIAL' } });
    const ok = await accept(p2.token, gym.id, false);
    expect([ok.status, ok.json.status]).toEqual([200, 'ACTIVE']);
    const row = await prisma.gymMember.findUniqueOrThrow({ where: { id: memberId } });
    expect([row.whatsappConsent, row.whatsappConsentAt]).toEqual([false, null]);
  });
});

describe('read-only gyms', () => {
  it('blocks every money write, while reading and the member’s own view still work', async () => {
    const owner = await adult('zo');
    const gym = await createGym(owner.token);
    const plan = await createPlan(owner, gym.id);
    const { person, memberId } = await enroll(owner, gym, 'zm');
    const fee = (await assign(owner, gym.id, memberId, { planId: plan.planId, startDate: today, dueDate: day(7) })).json;
    const payment = (await pay(owner, gym.id, fee.feeId, { amount: 100, method: 'CASH' })).json.payment;

    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'READ_ONLY' } });

    const writes: Array<[string, string, Json]> = [
      ['POST', `/gyms/${gym.id}/plans`, { name: 'New Plan', durationDays: 30, price: 100 }],
      ['PATCH', `/gyms/${gym.id}/plans/${plan.planId}`, { price: 600 }],
      ['POST', `/gyms/${gym.id}/members/${memberId}/fees`, { planId: plan.planId, startDate: day(60) }],
      ['POST', `/gyms/${gym.id}/fees/${fee.feeId}/payments`, { amount: 100, method: 'CASH' }],
      ['POST', `/gyms/${gym.id}/fees/${fee.feeId}/payments/${payment.paymentId}/reverse`, { reason: 'Blocked reversal' }],
      ['POST', `/gyms/${gym.id}/fees/${fee.feeId}/waive`, { reason: 'Blocked waiver' }],
    ];
    for (const [method, path, body] of writes) {
      const res = await api(method, path, { token: owner.token, body });
      expect([method, path, res.status, res.json.code]).toEqual([method, path, 403, 'GYM_READ_ONLY']);
    }

    expect((await api('GET', `/gyms/${gym.id}/plans`, { token: owner.token })).status).toBe(200);
    expect((await fees(owner.token, gym.id)).status).toBe(200);
    expect((await feeOf(owner.token, gym.id, fee.feeId)).status).toBe(200);
    expect((await myFees(person.token, gym.id)).status).toBe(200);

    const row = await prisma.memberFee.findUniqueOrThrow({ where: { id: fee.feeId } });
    expect([Number(row.amountPaid), row.status]).toEqual([100, 'PARTIAL']);
    expect(await prisma.feePayment.count({ where: { memberFeeId: fee.feeId } })).toBe(1);

    await prisma.gymSubscription.update({ where: { gymId: gym.id }, data: { status: 'TRIAL' } });
    expect((await pay(owner, gym.id, fee.feeId, { amount: 100, method: 'CASH' })).status).toBe(201);
  });
});