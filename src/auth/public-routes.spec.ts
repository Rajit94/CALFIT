import { APP_GUARD, Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppController } from '../app.controller.js';
import { HealthController } from '../health/health.controller.js';
import { AuthMeController } from './auth-me.controller.js';
import { SessionController } from './session.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthModule } from './auth.module.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

// Safety net: the guard protects everything by default, so routes that MUST stay open
// are listed here. If one loses its @Public() sign, these tests fail before users are locked out.
const reflector = new Reflector();
const isPublic = (target: object): boolean => reflector.get(IS_PUBLIC_KEY, target) === true;

describe('public routes', () => {
  it('keeps the OTP endpoints public', () => {
    expect(isPublic(AuthController.prototype.requestOtp)).toBe(true);
    expect(isPublic(AuthController.prototype.verifyOtp)).toBe(true);
  });

  it('keeps the health check and the root route public', () => {
    expect(isPublic(HealthController)).toBe(true);
    expect(isPublic(AppController)).toBe(true);
  });

  it('keeps refresh and logout public, because they are used when the access token has expired', () => {
    expect(isPublic(SessionController.prototype.refresh)).toBe(true);
    expect(isPublic(SessionController.prototype.logout)).toBe(true);
  });

  it('keeps logout-all protected', () => {
    expect(isPublic(SessionController.prototype.logoutAll)).toBe(false);
    expect(isPublic(SessionController)).toBe(false);
  });

  it('keeps /auth/me protected', () => {
    expect(isPublic(AuthMeController)).toBe(false);
    expect(isPublic(AuthMeController.prototype.getMe)).toBe(false);
  });

  it('registers JwtAuthGuard globally from AuthModule', () => {
    const providers = Reflect.getMetadata('providers', AuthModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    expect(providers.some((p) => p.provide === APP_GUARD && p.useClass === JwtAuthGuard)).toBe(true);
  });
});