import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface ClientDetails {
  ip: string | undefined;
  userAgent: string | undefined;
}

// Reads the caller's IP and User-Agent. Behind a proxy, configure "trust proxy" at deployment.
export const ClientInfo = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientDetails => {
    const req = ctx.switchToHttp().getRequest<{
      ip?: string;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const ua = req.headers['user-agent'];
    return { ip: req.ip, userAgent: Array.isArray(ua) ? ua[0] : ua };
  },
);