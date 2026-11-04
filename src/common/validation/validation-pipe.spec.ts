import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildErrorResponse } from '../errors/error-response.js';
import { createValidationPipe, issuesToException } from './validation-pipe.js';

const opts = {
  path: '/api/v1/test',
  isDevelopment: false,
  now: new Date('2026-11-04T10:00:00.000Z'),
};

describe('issuesToException', () => {
  it('maps issues to field/message details in the standard error format', () => {
    const body = buildErrorResponse(
      issuesToException([{ message: 'Required', path: ['phone'] }]),
      opts,
    );
    expect(body.statusCode).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toBe('Validation failed');
    expect(body.details).toEqual([{ field: 'phone', message: 'Required' }]);
  });

  it('joins nested paths and supports path segments given as objects', () => {
    const body = buildErrorResponse(
      issuesToException([{ message: 'Bad', path: ['device', { key: 'platform' }] }]),
      opts,
    );
    expect(body.details).toEqual([{ field: 'device.platform', message: 'Bad' }]);
  });

  it('keeps issues that have no path', () => {
    const body = buildErrorResponse(issuesToException([{ message: 'Root problem' }]), opts);
    expect(body.details).toEqual([{ message: 'Root problem' }]);
  });
});

describe('createValidationPipe', () => {
  const schema = z.object({ phone: z.string().trim().regex(/^\+\d+$/, 'bad phone') });
  const pipe = createValidationPipe();
  const run = async (value: unknown) => pipe.transform(value, { type: 'body', schema } as never);

  it('returns the parsed value for valid input', async () => {
    await expect(run({ phone: ' +911234567890 ' })).resolves.toEqual({ phone: '+911234567890' });
  });

  it('rejects invalid input with the standard validation exception', async () => {
    const error = await run({ phone: 'abc' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    const body = buildErrorResponse(error, opts);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details?.[0]?.field).toBe('phone');
  });
});