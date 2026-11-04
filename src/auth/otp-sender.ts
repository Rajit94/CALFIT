import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { maskPhone } from './validation.js';

// Contract for anything that can deliver an OTP (SMS provider, WhatsApp, ...).
export abstract class OtpSender {
  abstract send(phone: string, code: string): Promise<void>;
}

// Development only: prints the code to the server log. The env schema refuses
// OTP_PROVIDER=console in production, and this class refuses as well.
@Injectable()
export class ConsoleOtpSender extends OtpSender {
  private readonly logger = new Logger(ConsoleOtpSender.name);

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  async send(phone: string, code: string): Promise<void> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new Error('ConsoleOtpSender cannot be used in production');
    }
    this.logger.warn(`DEV OTP for ${maskPhone(phone)}: ${code}`);
  }
}