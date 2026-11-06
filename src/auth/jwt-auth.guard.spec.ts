import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from './auth.types.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Public } from './public.decorator.js';

const SECRET = 's'.repeat(32);
const UID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

interface SessionRow {
  id: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  user: { status: string };
}

function setup(session?: Partial<SessionRow> | null) {
  const row: SessionRow | null =
    session === null
      ? null
      : {
          id: SID,
          userId: UID,
          revokedAt: null,
          expiresAt: new Date(Date.now() + 86_400_000),
          user: { status: 'ACTIVE' },
          ...session,
        };
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
    row && row.id === where.id ? row : null,
  );
  const prisma = { session: { findUnique } };
  const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } });
  const guard = new JwtAuthGuard(new Reflector(), jwt, prisma as never);
  return { guard, jwt, findUnique };
}

function makeContext(headers: Record<string, string | undefined>, isPublic = false) {
  const request: AuthenticatedRequest = { headers };
  const handler = () => undefined;
  class TestController {}
  if (isPublic) Public()(handler as never);
  const context = {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { context: context as never, request };
}

const withToken = (token: string) => makeContext({ authorization: `Bearer ${token}` });

async function reject(promise: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code };
  }
  throw new Error('Expected the guard to reject');
}

describe('JwtAuthGuard', () => {
  it('lets public routes through without a token or a database lookup', async () => {
    const { guard, findUnique } = setup();
    const { context } = makeContext({}, true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a request with no Authorization header', async () => {
    const { guard } = setup();
    const { context } = makeContext({});
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_MISSING' });
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const { guard } = setup();
    const { context } = makeContext({ authorization: 'Basic abc' });
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
  });

  it('rejects a garbage token', async () => {
    const { guard } = setup();
    const { context } = withToken('not.a.jwt');
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
  });

  it('rejects a token signed with a different secret', async () => {
    const { guard } = setup();
    const forged = await new JwtService({ secret: 'x'.repeat(32) }).signAsync(
      { sub: UID, sid: SID },
      { expiresIn: 900 },
    );
    const { context } = withToken(forged);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const { guard, jwt } = setup();
    const expired = await jwt.signAsync({
      sub: UID,
      sid: SID,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const { context } = withToken(expired);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_EXPIRED' });
  });

  it('rejects an unsigned token (alg none)', async () => {
    const { guard } = setup();
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: UID, sid: SID })}.`;
    const { context } = withToken(unsigned);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
  });

  it('rejects a token signed with a different algorithm', async () => {
    const { guard } = setup();
    const hs512 = await new JwtService({ secret: SECRET }).signAsync(
      { sub: UID, sid: SID },
      { algorithm: 'HS512', expiresIn: 900 },
    );
    const { context } = withToken(hs512);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
  });

  it('rejects a token without user and session ids, without touching the database', async () => {
    const { guard, jwt, findUnique } = setup();
    const token = await jwt.signAsync({ foo: 'bar' }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects ids that are not UUIDs, without touching the database', async () => {
    const { guard, jwt, findUnique } = setup();
    const token = await jwt.signAsync({ sub: 'abc', sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'TOKEN_INVALID' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown session', async () => {
    const { guard, jwt } = setup(null);
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'SESSION_INVALID' });
  });

  it('rejects a session that belongs to another user', async () => {
    const { guard, jwt } = setup({ userId: '33333333-3333-4333-8333-333333333333' });
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'SESSION_INVALID' });
  });

  it('rejects a revoked session', async () => {
    const { guard, jwt } = setup({ revokedAt: new Date() });
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'SESSION_REVOKED' });
  });

  it('rejects an expired session', async () => {
    const { guard, jwt } = setup({ expiresAt: new Date(Date.now() - 1000) });
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 401, code: 'SESSION_INVALID' });
  });

  it('rejects a suspended user', async () => {
    const { guard, jwt } = setup({ user: { status: 'SUSPENDED' } });
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 403, code: 'ACCOUNT_SUSPENDED' });
  });

  it('rejects a deleted user', async () => {
    const { guard, jwt } = setup({ user: { status: 'DELETED' } });
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = withToken(token);
    expect(await reject(guard.canActivate(context))).toEqual({ status: 403, code: 'ACCOUNT_DELETED' });
  });

  it('accepts a valid token and attaches the user to the request', async () => {
    const { guard, jwt, findUnique } = setup();
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context, request } = withToken(token);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: UID, sessionId: SID });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0]?.[0].where).toEqual({ id: SID });
  });

  it('accepts a lowercase bearer scheme', async () => {
    const { guard, jwt } = setup();
    const token = await jwt.signAsync({ sub: UID, sid: SID }, { expiresIn: 900 });
    const { context } = makeContext({ authorization: `bearer ${token}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});