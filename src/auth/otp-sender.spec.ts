import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleOtpSender } from './otp-sender.js';

const config = (env: string) => ({ get: () => env }) as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConsoleOtpSender', () => {
  it('logs the code in development without printing the full phone number', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await new ConsoleOtpSender(config('development')).send('+919876543210', '123456');
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('123456');
    expect(line).toContain('+91******3210');
    expect(line).not.toContain('+919876543210');
  });

  it('refuses to run in production', async () => {
    await expect(
      new ConsoleOtpSender(config('production')).send('+919876543210', '123456'),
    ).rejects.toThrow();
  });
});