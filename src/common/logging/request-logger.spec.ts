import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { getRequestId } from './request-context.js';
import {
  cleanPath,
  createRequestLogger,
  resolveRequestId,
  shouldSkip,
} from './request-logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('reuses a valid incoming id', () => {
    expect(resolveRequestId('abcd1234-test')).toBe('abcd1234-test');
  });

  it('uses the first value when the header is an array', () => {
    expect(resolveRequestId(['abcd1234-one', 'abcd1234-two'])).toBe('abcd1234-one');
  });

  it('replaces an id containing illegal characters (log injection)', () => {
    expect(resolveRequestId('abcd1234\nFAKE LOG LINE')).toMatch(UUID);
  });

  it('replaces ids that are too short or too long', () => {
    expect(resolveRequestId('short')).toMatch(UUID);
    expect(resolveRequestId('x'.repeat(65))).toMatch(UUID);
  });

  it('generates an id when none is sent', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
  });
});

describe('cleanPath and shouldSkip', () => {
  it('strips the query string', () => {
    expect(cleanPath('/api/v1/gyms?token=secret&page=2')).toBe('/api/v1/gyms');
  });

  it('skips health and docs but not normal routes', () => {
    expect(shouldSkip('/api/v1/health')).toBe(true);
    expect(shouldSkip('/api/docs')).toBe(true);
    expect(shouldSkip('/api/docs-json')).toBe(true);
    expect(shouldSkip('/api/v1/gyms')).toBe(false);
  });
});

function harness(url: string, status = 200) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const responseHeaders: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: status,
    setHeader: (name: string, value: string) => {
      responseHeaders[name] = value;
    },
  });
  const req = {
    method: 'GET',
    url,
    originalUrl: url,
    headers: { 'x-request-id': 'abcd1234-test' } as Record<string, string>,
  };
  let seenId: string | undefined;
  const next = vi.fn(() => {
    seenId = getRequestId();
  });
  const times = [100, 142]; // start, end -> 42ms
  const middleware = createRequestLogger(logger, () => times.shift() ?? 0);
  middleware(req, res, next);
  return { logger, res, responseHeaders, next, seenId: () => seenId };
}

describe('createRequestLogger', () => {
  it('sets the X-Request-Id response header', () => {
    const h = harness('/api/v1/gyms');
    expect(h.responseHeaders['X-Request-Id']).toBe('abcd1234-test');
  });

  it('runs next() inside the request context', () => {
    const h = harness('/api/v1/gyms');
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.seenId()).toBe('abcd1234-test');
  });

  it('logs a successful request at log level, without the query string', () => {
    const h = harness('/api/v1/gyms?token=secret', 200);
    h.res.emit('finish');
    expect(h.logger.log).toHaveBeenCalledTimes(1);
    const message = h.logger.log.mock.calls[0]?.[0] as string;
    expect(message).toContain('GET /api/v1/gyms 200 42ms');
    expect(message).toContain('rid=abcd1234-test');
    expect(message).not.toContain('secret');
  });

  it('logs a 404 at warn level', () => {
    const h = harness('/api/v1/nope', 404);
    h.res.emit('finish');
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.log).not.toHaveBeenCalled();
  });

  it('logs a 500 at error level', () => {
    const h = harness('/api/v1/boom', 500);
    h.res.emit('finish');
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('does not log health checks', () => {
    const h = harness('/api/v1/health', 200);
    h.res.emit('finish');
    expect(h.logger.log).not.toHaveBeenCalled();
    expect(h.next).toHaveBeenCalledTimes(1);
  });

  it('logs an aborted request when the connection closes before finishing', () => {
    const h = harness('/api/v1/gyms');
    h.res.emit('close');
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]?.[0]).toContain('aborted');
  });

  it('logs only once when finish is followed by close', () => {
    const h = harness('/api/v1/gyms');
    h.res.emit('finish');
    h.res.emit('close');
    expect(h.logger.log).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});