import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.schema.js';
import { AuthMeController } from './auth-me.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GymMemberLinkService } from './gym-member-link.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { LogoutService } from './logout.service.js';
import { MeService } from './me.service.js';
import { ConsoleOtpSender, OtpSender } from './otp-sender.js';
import { OtpService } from './otp.service.js';
import { RefreshService } from './refresh.service.js';
import { SessionController } from './session.controller.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' as const },
        verifyOptions: { algorithms: ['HS256' as const] },
      }),
    }),
  ],
  controllers: [AuthController, AuthMeController, SessionController],
  providers: [
    AuthService,
    MeService,
    RefreshService,
    LogoutService,
    GymMemberLinkService,
    OtpService,
    { provide: OtpSender, useClass: ConsoleOtpSender },
    // Protects every route unless it is marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}