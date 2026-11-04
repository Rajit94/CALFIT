import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildErrorResponse } from './error-response.js';

const opts = {
  path: '/api/v1/test',
  isDevelopment: false,
  now: new Date('2026-11-01T10:00:00.000Z'),
};

class FakePrismaError extends Error {
  code?: string;
  constructor(name: string, code?: string) {
    super('secret db message about column "phone"');
    this.name = name;
    this.code = code;
  }
}

describe('buildErrorResponse', () => {
  it('formats a 404 HttpException', () => {
    const body = buildErrorResponse(new NotFoundException('Gym not found'), opts);
    expect(body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      code: 'NOT_FOUND',
      message: 'Gym not found',
      path: '/api/v1/test',
      timestamp: '2026-11-01T10:00:00.000Z',
    });
  });

  it('turns an array of messages into validation details', () => {
    const body = buildErrorResponse(
      new BadRequestException({ message: ['phone must be valid', 'name should not be empty'] }),
      opts,
    );
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.details).toEqual([
      { message: 'phone must be valid' },
      { message: 'name should not be empty' },
    ]);
  });

  it('reads field names from issue objects with a path', () => {
    const body = buildErrorResponse(
      new BadRequestException({ message: [{ path: ['user', 'phone'], message: 'Invalid' }] }),
      opts,
    );
    expect(body.details).toEqual([{ field: 'user.phone', message: 'Invalid' }]);
  });

  it('passes through a custom machine-readable code', () => {
    const body = buildErrorResponse(
      new BadRequestException({ code: 'OTP_EXPIRED', message: 'OTP has expired' }),
      opts,
    );
    expect(body.code).toBe('OTP_EXPIRED');
    expect(body.message).toBe('OTP has expired');
  });

  it('hides the message of a plain 500 HttpException', () => {
    const body = buildErrorResponse(new HttpException('password is hunter2', 500), opts);
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('keeps the message of a deliberate 503', () => {
    const body = buildErrorResponse(new ServiceUnavailableException('Database is unreachable'), opts);
    expect(body.statusCode).toBe(503);
    expect(body.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.message).toBe('Database is unreachable');
  });

  it('maps Prisma P2002 to 409 without leaking database details', () => {
    const body = buildErrorResponse(
      new FakePrismaError('PrismaClientKnownRequestError', 'P2002'),
      opts,
    );
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe('DUPLICATE_RECORD');
    expect(JSON.stringify(body)).not.toContain('phone');
  });

  it('maps Prisma P2025 to 404', () => {
    const body = buildErrorResponse(
      new FakePrismaError('PrismaClientKnownRequestError', 'P2025'),
      opts,
    );
    expect(body.statusCode).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
  });

  it('maps Prisma P2003 to 409', () => {
    const body = buildErrorResponse(
      new FakePrismaError('PrismaClientKnownRequestError', 'P2003'),
      opts,
    );
    expect(body.statusCode).toBe(409);
    expect(body.code).toBe('RELATED_RECORD_CONFLICT');
  });

  it('maps a Prisma initialization error to 503', () => {
    const body = buildErrorResponse(new FakePrismaError('PrismaClientInitializationError'), opts);
    expect(body.statusCode).toBe(503);
    expect(body.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('hides unexpected errors in production', () => {
    const body = buildErrorResponse(new Error('connection string postgres://u:p@h/db'), opts);
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.debug).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('adds a debug stack for unexpected errors in development', () => {
    const body = buildErrorResponse(new Error('boom'), { ...opts, isDevelopment: true });
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.debug?.stack).toContain('boom');
  });

  it('strips the query string from the built-in route-not-found message', () => {
    const body = buildErrorResponse(
      new NotFoundException('Cannot GET /api/v1/nope?token=secret123'),
      opts,
    );
    expect(body.message).toBe('Cannot GET /api/v1/nope');
    expect(JSON.stringify(body)).not.toContain('secret123');
  });
  it('includes the request id when one is available', () => {
    const body = buildErrorResponse(new NotFoundException('Nope'), {
      ...opts,
      requestId: 'abcd1234-test',
    });
    expect(body.requestId).toBe('abcd1234-test');
  });

  it('omits requestId when none is available', () => {
    const body = buildErrorResponse(new NotFoundException('Nope'), opts);
    expect('requestId' in body).toBe(false);
  });

  it('handles a non-Error thrown value', () => {
    const body = buildErrorResponse('boom', opts);
    expect(body.statusCode).toBe(500);
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('reads errorCode from a Nest 12 exception options object', () => {
    const body = buildErrorResponse(
      new BadRequestException('OTP has expired', { errorCode: 'OTP_EXPIRED' }),
      opts,
    );
    expect(body.code).toBe('OTP_EXPIRED');
    expect(body.message).toBe('OTP has expired');
  });

  it('reads errorCode from an object response', () => {
    const body = buildErrorResponse(
      new BadRequestException({ errorCode: 'OTP_INVALID', message: 'Invalid code' }),
      opts,
    );
    expect(body.code).toBe('OTP_INVALID');
  });});