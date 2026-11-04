import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readNumber, readSecret } from './auth-config.js';
import { OtpSender } from './otp-sender.js';
import { generateOtpCode, hashOtp, verifyOtp } from './otp.crypto.js';
import { maskPhone } from './validation.js';

const HOUR_MS = 3_600_000;

export interface OtpRequestResult {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

interface OtpSettings {
  pepper: string;
  ttlSeconds: number;
  maxAttempts: number;
  cooldownSeconds: number;
  maxPerPhonePerHour: number;
  maxPerIpPerHour: number;
  devFixedCode: string | undefined;
}

function tooMany(code: string, message: string): HttpException {
  return new HttpException({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
}

function expiredError(): BadRequestException {
  return new BadRequestException({
    code: 'OTP_EXPIRED',
    message: 'This code has expired or was not requested. Please request a new one.',
  });
}

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly settings: OtpSettings;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly sender: OtpSender,
  ) {
    this.settings = {
      pepper: readSecret(config, 'OTP_PEPPER'),
      ttlSeconds: readNumber(config, 'OTP_TTL_SECONDS'),
      maxAttempts: readNumber(config, 'OTP_MAX_ATTEMPTS'),
      cooldownSeconds: readNumber(config, 'OTP_RESEND_COOLDOWN_SECONDS'),
      maxPerPhonePerHour: readNumber(config, 'OTP_MAX_SENDS_PER_PHONE_PER_HOUR'),
      maxPerIpPerHour: readNumber(config, 'OTP_MAX_SENDS_PER_IP_PER_HOUR'),
      devFixedCode: config.get('OTP_DEV_FIXED_CODE', { infer: true }),
    };
  }

  async requestOtp(phone: string, ip: string | undefined): Promise<OtpRequestResult> {
    const s = this.settings;
    const now = new Date();

    // 1. Resend cooldown
    const latest = await this.prisma.otpRequest.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latest) {
      const waitMs = latest.createdAt.getTime() + s.cooldownSeconds * 1000 - now.getTime();
      if (waitMs > 0) {
        throw tooMany(
          'OTP_RESEND_TOO_SOON',
          `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.`,
        );
      }
    }

    // 2. Hourly limits per phone and per IP
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const sentToPhone = await this.prisma.otpRequest.count({
      where: { phone, createdAt: { gte: hourAgo } },
    });
    if (sentToPhone >= s.maxPerPhonePerHour) {
      throw tooMany(
        'OTP_PHONE_LIMIT_REACHED',
        'Too many codes requested for this number. Please try again later.',
      );
    }
    if (ip) {
      const sentFromIp = await this.prisma.otpRequest.count({
        where: { ip, createdAt: { gte: hourAgo } },
      });
      if (sentFromIp >= s.maxPerIpPerHour) {
        throw tooMany(
          'OTP_IP_LIMIT_REACHED',
          'Too many codes requested from this network. Please try again later.',
        );
      }
    }

    // 3. Create and send. Only the hash is stored.
    const code = s.devFixedCode ?? generateOtpCode();
    const record = await this.prisma.otpRequest.create({
      data: {
        phone,
        codeHash: hashOtp(s.pepper, phone, code),
        expiresAt: new Date(now.getTime() + s.ttlSeconds * 1000),
        ip: ip ?? null,
      },
      select: { id: true },
    });

    try {
      await this.sender.send(phone, code);
    } catch (error) {
      await this.prisma.otpRequest.delete({ where: { id: record.id } }).catch(() => undefined);
      this.logger.error(
        `Failed to send OTP to ${maskPhone(phone)}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException({
        code: 'OTP_SEND_FAILED',
        message: 'Could not send the code. Please try again.',
      });
    }

    return { expiresInSeconds: s.ttlSeconds, resendAfterSeconds: s.cooldownSeconds };
  }

  // Resolves when the code is valid (and consumes it); throws otherwise.
  async verifyOtp(phone: string, code: string): Promise<void> {
    const s = this.settings;
    const now = new Date();

    // Only the most recent code is valid.
    const latest = await this.prisma.otpRequest.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest || latest.consumedAt !== null || latest.expiresAt.getTime() <= now.getTime()) {
      throw expiredError();
    }

    // Count the attempt atomically BEFORE comparing, so parallel guesses cannot exceed the limit.
    const counted = await this.prisma.otpRequest.updateMany({
      where: { id: latest.id, consumedAt: null, attempts: { lt: s.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) {
      throw tooMany(
        'OTP_ATTEMPTS_EXCEEDED',
        'Too many incorrect attempts. Please request a new code.',
      );
    }

    if (!verifyOtp(s.pepper, phone, code, latest.codeHash)) {
      throw new BadRequestException({ code: 'OTP_INVALID', message: 'The code is incorrect.' });
    }

    // Consume exactly once, even under concurrent requests.
    const consumed = await this.prisma.otpRequest.updateMany({
      where: { id: latest.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) throw expiredError();
  }
}