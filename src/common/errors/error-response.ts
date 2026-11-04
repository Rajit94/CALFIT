import { HttpException } from '@nestjs/common';

export interface ErrorDetail {
  field?: string;
  message: string;
}

export interface ErrorResponse {
  statusCode: number;
  error: string; // HTTP reason phrase, e.g. "Not Found"
  code: string; // machine-readable, e.g. "NOT_FOUND" or a custom business code
  message: string; // human-readable, safe to show
  details?: ErrorDetail[];
  path: string;
  timestamp: string;
  requestId?: string; // echoes the X-Request-Id header
  debug?: { name: string; stack?: string }; // development only, 5xx only
}

export interface BuildErrorOptions {
  path: string;
  isDevelopment: boolean;
  now?: Date;
  requestId?: string | undefined;
}

const GENERIC_500 = 'Internal server error';
const ROUTE_NOT_FOUND_QUERY = /^(Cannot [A-Z]+ [^\s?]*)\?\S*/;

const STATUS_INFO: Record<number, { error: string; code: string }> = {
  400: { error: 'Bad Request', code: 'BAD_REQUEST' },
  401: { error: 'Unauthorized', code: 'UNAUTHORIZED' },
  403: { error: 'Forbidden', code: 'FORBIDDEN' },
  404: { error: 'Not Found', code: 'NOT_FOUND' },
  405: { error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' },
  409: { error: 'Conflict', code: 'CONFLICT' },
  413: { error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE' },
  415: { error: 'Unsupported Media Type', code: 'UNSUPPORTED_MEDIA_TYPE' },
  422: { error: 'Unprocessable Entity', code: 'UNPROCESSABLE_ENTITY' },
  429: { error: 'Too Many Requests', code: 'TOO_MANY_REQUESTS' },
  500: { error: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR' },
  502: { error: 'Bad Gateway', code: 'BAD_GATEWAY' },
  503: { error: 'Service Unavailable', code: 'SERVICE_UNAVAILABLE' },
  504: { error: 'Gateway Timeout', code: 'GATEWAY_TIMEOUT' },
};

function statusInfo(status: number): { error: string; code: string } {
  return (
    STATUS_INFO[status] ??
    (status >= 500
      ? { error: 'Server Error', code: 'SERVER_ERROR' }
      : { error: 'Error', code: `HTTP_${status}` })
  );
}

function pathKey(segment: unknown): string {
  if (segment && typeof segment === 'object' && 'key' in segment) {
    return String((segment as { key: unknown }).key);
  }
  return String(segment);
}

// Accepts strings, or objects like { message, field } / { message, path: [...] }
// (the shapes validation libraries commonly produce).
function toDetails(items: unknown[]): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      out.push({ message: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as { message?: unknown; field?: unknown; path?: unknown };
      if (typeof rec.message !== 'string') continue;
      let field: string | undefined;
      if (typeof rec.field === 'string') field = rec.field;
      else if (Array.isArray(rec.path)) field = rec.path.map(pathKey).join('.') || undefined;
      else if (typeof rec.path === 'string') field = rec.path;
      out.push(field ? { field, message: rec.message } : { message: rec.message });
    }
  }
  return out;
}

// Prisma errors are recognised by name/code (no import of the generated client).
function mapPrismaError(
  e: unknown,
): { status: number; code: string; message: string } | undefined {
  if (!(e instanceof Error) || !e.name.startsWith('PrismaClient')) return undefined;
  if (e.name === 'PrismaClientKnownRequestError') {
    const code = (e as { code?: unknown }).code;
    switch (code) {
      case 'P2002':
        return {
          status: 409,
          code: 'DUPLICATE_RECORD',
          message: 'A record with the same unique value already exists',
        };
      case 'P2003':
        return {
          status: 409,
          code: 'RELATED_RECORD_CONFLICT',
          message: 'The operation conflicts with related records',
        };
      case 'P2025':
        return { status: 404, code: 'NOT_FOUND', message: 'Resource not found' };
      default:
        return undefined;
    }
  }
  if (e.name === 'PrismaClientInitializationError') {
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'Service temporarily unavailable',
    };
  }
  return undefined;
}

function debugInfo(e: unknown): ErrorResponse['debug'] {
  return e instanceof Error ? { name: e.name, stack: e.stack } : { name: 'NonError' };
}

export function buildErrorResponse(
  exception: unknown,
  options: BuildErrorOptions,
): ErrorResponse {
  const { path, isDevelopment, requestId } = options;
  const timestamp = (options.now ?? new Date()).toISOString();

  const make = (
    status: number,
    code: string,
    message: string,
    details?: ErrorDetail[],
    debug?: ErrorResponse['debug'],
  ): ErrorResponse => ({
    statusCode: status,
    error: statusInfo(status).error,
    code,
    message,
    ...(details && details.length > 0 ? { details } : {}),
    path,
    timestamp,
    ...(requestId ? { requestId } : {}),
    ...(debug ? { debug } : {}),
  });

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const info = statusInfo(status);
    const raw = exception.getResponse();
    let code = info.code;
    let message = info.error;
    let details: ErrorDetail[] | undefined;

    if (typeof raw === 'string') {
      message = raw;
    } else if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      if (typeof r.code === 'string') code = r.code;
      else if (typeof r.errorCode === 'string') code = r.errorCode; // Nest 12 HttpExceptionOptions
      if (Array.isArray(r.details)) details = toDetails(r.details);
      if (Array.isArray(r.message)) {
        const list = toDetails(r.message);
        details = details ?? list;
        message =
          status === 400 || status === 422
            ? 'Validation failed'
            : list.map((d) => d.message).join('; ');
      } else if (typeof r.message === 'string') {
        message = r.message;
      }
    }

    // Nest's built-in route-not-found message echoes the URL; drop any query string.
    if (status === 404) message = message.replace(ROUTE_NOT_FOUND_QUERY, (_m, route: string) => route);

    // Never pass a free-text message through on a plain 500.
    if (status === 500) {
      code = info.code;
      message = GENERIC_500;
      details = undefined;
    }

    return make(
      status,
      code,
      message,
      details,
      isDevelopment && status >= 500 ? debugInfo(exception) : undefined,
    );
  }

  const prisma = mapPrismaError(exception);
  if (prisma) {
    return make(
      prisma.status,
      prisma.code,
      prisma.message,
      undefined,
      isDevelopment && prisma.status >= 500 ? debugInfo(exception) : undefined,
    );
  }

  return make(
    500,
    'INTERNAL_SERVER_ERROR',
    GENERIC_500,
    undefined,
    isDevelopment ? debugInfo(exception) : undefined,
  );
}