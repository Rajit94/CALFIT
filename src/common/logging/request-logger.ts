import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requestContext } from './request-context.js';

// Minimal shapes, so we do not depend on Express types.
interface RequestLike {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish' | 'close', listener: () => void): unknown;
}

export interface LogSink {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

// Noisy endpoints that are not worth a log line per call.
const SKIPPED_PREFIXES = ['/api/v1/health', '/api/docs'];

export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && VALID_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

// Never log the query string: it can carry tokens.
export function cleanPath(url: string): string {
  return url.split('?')[0] ?? '';
}

export function shouldSkip(path: string): boolean {
  return SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function createRequestLogger(
  logger: LogSink = new Logger('HTTP'),
  now: () => number = () => performance.now(),
) {
  return (req: RequestLike, res: ResponseLike, next: () => void): void => {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);

    const path = cleanPath(req.originalUrl ?? req.url);
    const start = now();

    if (!shouldSkip(path)) {
      let finished = false;
      const elapsed = (): number => Math.round(now() - start);

      res.on('finish', () => {
        finished = true;
        const status = res.statusCode;
        const message = `${req.method} ${path} ${status} ${elapsed()}ms rid=${requestId}`;
        if (status >= 500) logger.error(message);
        else if (status >= 400) logger.warn(message);
        else logger.log(message);
      });

      // The client disconnected before we finished responding.
      res.on('close', () => {
        if (finished) return;
        logger.warn(`${req.method} ${path} aborted after ${elapsed()}ms rid=${requestId}`);
      });
    }

    requestContext.run({ requestId }, next);
  };
}