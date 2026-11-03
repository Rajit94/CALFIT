import { Logger, NotFoundException } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../logging/request-context.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function setup(nodeEnv: string) {
  const reply = vi.fn();
  const adapterHost = {
    httpAdapter: {
      reply,
      getRequestUrl: () => '/api/v1/x?token=secret',
      getRequestMethod: () => 'GET',
    },
  };
  const config = { get: () => nodeEnv };
  const filter = new AllExceptionsFilter(adapterHost as never, config as never);
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
  };
  const lastCall = () => reply.mock.calls[0] as [unknown, Record<string, unknown>, number];
  return { filter, host: host as never, lastCall };
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    Logger.overrideLogger(false); // keep test output quiet
  });

  it('replies with the standard shape and strips the query string', () => {
    const { filter, host, lastCall } = setup('production');
    filter.catch(new NotFoundException('Nope'), host);
    const [, body, status] = lastCall();
    expect(status).toBe(404);
    expect(body.path).toBe('/api/v1/x');
    expect(body.code).toBe('NOT_FOUND');
    expect(body.message).toBe('Nope');
  });

  it('hides internals of unexpected errors in production', () => {
    const { filter, host, lastCall } = setup('production');
    filter.catch(new Error('secret internals'), host);
    const [, body, status] = lastCall();
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.debug).toBeUndefined();
  });

  it('adds the current request id to the response', () => {
    const { filter, host, lastCall } = setup('production');
    requestContext.run({ requestId: 'abcd1234-test' }, () => {
      filter.catch(new NotFoundException('Nope'), host);
    });
    const [, body] = lastCall();
    expect(body.requestId).toBe('abcd1234-test');
  });

  it('includes debug info for unexpected errors in development', () => {
    const { filter, host, lastCall } = setup('development');
    filter.catch(new Error('boom'), host);
    const [, body] = lastCall();
    expect(body.debug).toBeDefined();
  });
});