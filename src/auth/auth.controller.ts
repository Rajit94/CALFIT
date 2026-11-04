import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { requestOtpSchema, verifyOtpSchema } from './auth.schemas.js';
import type { RequestOtpDto, VerifyOtpDto } from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { ClientInfo } from './client-info.decorator.js';
import type { ClientDetails } from './client-info.decorator.js';
import { OtpService } from './otp.service.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly auth: AuthService,
  ) {}

  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a one-time code to a phone number',
    description:
      'Works for new and existing numbers alike and never reveals whether the number is registered. ' +
      'In development the code is printed to the server log (and equals OTP_DEV_FIXED_CODE if set).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone'],
      properties: {
        phone: { type: 'string', example: '+919876543210', description: 'International format (E.164)' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Code sent.',
    schema: {
      type: 'object',
      properties: {
        expiresInSeconds: { type: 'number', example: 300 },
        resendAfterSeconds: { type: 'number', example: 30 },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({
    status: 429,
    description: 'OTP_RESEND_TOO_SOON, OTP_PHONE_LIMIT_REACHED or OTP_IP_LIMIT_REACHED',
  })
  @ApiResponse({ status: 503, description: 'OTP_SEND_FAILED' })
  async requestOtp(
    @Body({ schema: requestOtpSchema }) body: RequestOtpDto,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.otp.requestOtp(body.phone, client.ip);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the code and sign in (creates the account for a new number)',
    description:
      'Registration and login are the same call. isNewUser and user.profileCompleted tell the app ' +
      'whether to show profile setup.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'code', 'acceptedTerms'],
      properties: {
        phone: { type: 'string', example: '+919876543210' },
        code: { type: 'string', example: '123456' },
        acceptedTerms: { type: 'boolean', example: true, description: 'Terms and Privacy Policy accepted' },
        device: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'Pixel 8' },
            platform: { type: 'string', enum: ['ios', 'android', 'web'] },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Signed in.',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        tokenType: { type: 'string', example: 'Bearer' },
        expiresIn: { type: 'number', example: 900 },
        refreshExpiresAt: { type: 'string', format: 'date-time' },
        isNewUser: { type: 'boolean' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            username: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            avatarUrl: { type: 'string', nullable: true },
            profileCompleted: { type: 'boolean' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED, OTP_INVALID or OTP_EXPIRED' })
  @ApiResponse({ status: 403, description: 'ACCOUNT_SUSPENDED or ACCOUNT_DELETED' })
  @ApiResponse({ status: 429, description: 'OTP_ATTEMPTS_EXCEEDED' })
  async verifyOtp(
    @Body({ schema: verifyOtpSchema }) body: VerifyOtpDto,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.auth.verifyOtpAndSignIn(
      { phone: body.phone, code: body.code, device: body.device },
      client,
    );
  }
}