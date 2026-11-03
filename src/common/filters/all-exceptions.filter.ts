import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { Env } from '../../config/env.schema.js';
import { buildErrorResponse } from '../errors/error-response.js';
import { getRequestId } from '../logging/request-context.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly config: ConfigService<Env, true>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const stack = exception instanceof Error ? exception.stack : String(exception);

    if (host.getType() !== 'http') {
      this.logger.error('Unhandled non-HTTP exception', stack);
      return;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    // Strip the query string so tokens in URLs never reach logs or responses.
    const path = String(httpAdapter.getRequestUrl(request)).split('?')[0] ?? '';
    const method = String(httpAdapter.getRequestMethod(request));
    const isDevelopment = this.config.get('NODE_ENV', { infer: true }) === 'development';

    const requestId = getRequestId();
    const body = buildErrorResponse(exception, { path, isDevelopment, requestId });
    const rid = requestId ? ` rid=${requestId}` : '';

    if (body.statusCode >= 500) {
      this.logger.error(`${method} ${path} -> ${body.statusCode} ${body.code}${rid}`, stack);
    } else {
      this.logger.warn(`${method} ${path} -> ${body.statusCode} ${body.code}: ${body.message}${rid}`);
    }

    httpAdapter.reply(ctx.getResponse(), body, body.statusCode);
  }
}