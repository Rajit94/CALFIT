import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from './auth.types.js';
import { CurrentUser } from './current-user.decorator.js';
import { MeService } from './me.service.js';

// Protected endpoints: there is no @Public() here, so JwtAuthGuard applies to every route.
@ApiTags('Auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthMeController {
  constructor(private readonly me: MeService) {}

  @Get('me')
  @ApiOperation({
    summary: 'The signed-in user, their profile status and gym memberships',
    description:
      'Send the access token as "Authorization: Bearer <token>". ' +
      'profileCompleted=false means the app should show profile setup.',
  })
  @ApiResponse({
    status: 200,
    description: 'The current user.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        phone: { type: 'string', example: '+919876543210' },
        username: { type: 'string', nullable: true },
        name: { type: 'string', nullable: true },
        avatarUrl: { type: 'string', nullable: true },
        bio: { type: 'string', nullable: true },
        privacy: { type: 'string', enum: ['PUBLIC', 'PRIVATE'] },
        profileCompleted: { type: 'boolean' },
        dateOfBirth: { type: 'string', format: 'date', nullable: true },
        ageGroup: { type: 'string', enum: ['MINOR', 'ADULT'], nullable: true },
        profileNextStep: {
          type: 'string',
          enum: ['PROFILE_DETAILS', 'GUARDIAN_CONSENT', 'GUARDIAN_VERIFICATION', 'DONE'],
        },
        guardianConsent: {
          type: 'object',
          properties: {
            required: { type: 'boolean' },
            status: { type: 'string', enum: ['NOT_REQUIRED', 'NOT_STARTED', 'PENDING', 'VERIFIED'] },
            guardianPhoneMasked: { type: 'string', nullable: true },
          },
        },
        createdAt: { type: 'string', format: 'date-time' },
        gyms: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              gymId: { type: 'string', format: 'uuid' },
              gymName: { type: 'string' },
              role: { type: 'string', enum: ['OWNER', 'TRAINER', 'MEMBER'] },
              status: { type: 'string', enum: ['INVITED', 'PENDING', 'ACTIVE'] },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'TOKEN_MISSING, TOKEN_INVALID, TOKEN_EXPIRED, SESSION_INVALID or SESSION_REVOKED',
  })
  @ApiResponse({ status: 403, description: 'ACCOUNT_SUSPENDED or ACCOUNT_DELETED' })
  async getMe(@CurrentUser() user: AuthUser) {
    return this.me.getMe(user.id);
  }
}