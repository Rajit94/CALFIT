import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { ClientInfo } from '../auth/client-info.decorator.js';
import type { ClientDetails } from '../auth/client-info.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { issuesToException } from '../common/validation/validation-pipe.js';
import {
  guardianSchema,
  guardianVerifySchema,
  setupProfileSchema,
  updateProfileSchema,
  usernameSchema,
} from './users.schemas.js';
import type {
  GuardianDto,
  GuardianVerifyDto,
  SetupProfileDto,
  UpdateProfileDto,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

// Every route here is protected: there is no @Public() on this controller.
// Keep static routes (username-available, me/...) above any future ":id" routes.
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('username-available')
  @ApiOperation({
    summary: 'Check whether a username can be used',
    description:
      'Usernames are 3-30 characters: lowercase letters, numbers, "_" and "."; no leading/trailing/double dots; ' +
      'reserved words are refused. An invalid username answers 400 VALIDATION_FAILED with the reason.',
  })
  @ApiQuery({ name: 'username', required: true, example: 'rajit.k' })
  @ApiResponse({
    status: 200,
    description: 'Availability.',
    schema: {
      type: 'object',
      properties: { username: { type: 'string' }, available: { type: 'boolean' } },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  async usernameAvailable(
    @Query('username') username: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) {
      throw issuesToException(
        parsed.error.issues.map((issue) => ({ message: issue.message, path: ['username'] })),
      );
    }
    return { username: parsed.data, available: await this.users.isUsernameAvailable(parsed.data, user.id) };
  }

  @Put('me/profile')
  @ApiOperation({
    summary: 'Set up the profile for the first time',
    description:
      'Allowed until the profile is complete. The date of birth (YYYY-MM-DD) is locked once saved. ' +
      'Adults complete the profile in this call. Ages 10-17 are saved but stay incomplete (and PRIVATE) until a ' +
      'guardian code is verified; the response profileNextStep says what to show next. Under 10 is refused. ' +
      'The guardian code verifies control of the guardian\'s phone number only; it does not establish legal guardianship.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'username', 'dateOfBirth'],
      properties: {
        name: { type: 'string', example: 'Rajit Kumar' },
        username: { type: 'string', example: 'rajit.k' },
        dateOfBirth: { type: 'string', format: 'date', example: '1995-05-20' },
        bio: { type: 'string', example: 'Lifting daily', description: 'Up to 150 characters' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'The profile: id, username, name, bio, privacy, dateOfBirth, ageGroup, profileCompleted, profileNextStep, guardianConsent.',
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED or DATE_OF_BIRTH_INVALID' })
  @ApiResponse({ status: 403, description: 'AGE_TOO_YOUNG' })
  @ApiResponse({
    status: 409,
    description: 'USERNAME_TAKEN, PROFILE_ALREADY_COMPLETED or DATE_OF_BIRTH_LOCKED',
  })
  async setupProfile(
    @Body({ schema: setupProfileSchema }) body: SetupProfileDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.users.setupProfile(user.id, body);
  }

  @Patch('me/profile')
  @ApiOperation({
    summary: 'Edit the profile',
    description:
      'Send only the fields to change: name, bio (empty string clears it), username, privacy. Unknown fields, ' +
      'including dateOfBirth, are rejected. The username can change once every 30 days. Accounts under 18 ' +
      'cannot be PUBLIC. The profile must be complete first.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        username: { type: 'string' },
        bio: { type: 'string' },
        privacy: { type: 'string', enum: ['PUBLIC', 'PRIVATE'] },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'The updated profile.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'MINOR_MUST_BE_PRIVATE' })
  @ApiResponse({ status: 409, description: 'USERNAME_TAKEN or PROFILE_NOT_COMPLETED' })
  @ApiResponse({ status: 429, description: 'USERNAME_CHANGE_TOO_SOON' })
  async updateProfile(
    @Body({ schema: updateProfileSchema }) body: UpdateProfileDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.users.updateProfile(user.id, body, client.ip);
  }

  @Post('me/guardian')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask for guardian consent (ages 10-17)',
    description:
      'Sends a one-time code to the guardian\'s phone. Verifying it proves control of that phone number; it does not ' +
      'establish legal guardianship. Calling this again replaces the guardian details until consent is verified.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['guardianName', 'guardianPhone'],
      properties: {
        guardianName: { type: 'string', example: 'Asha Kumar' },
        guardianPhone: { type: 'string', example: '+919876543299' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Code sent.',
    schema: {
      type: 'object',
      properties: {
        guardianPhoneMasked: { type: 'string', example: '+91******3299' },
        expiresInSeconds: { type: 'number', example: 300 },
        resendAfterSeconds: { type: 'number', example: 30 },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED or GUARDIAN_PHONE_INVALID' })
  @ApiResponse({
    status: 409,
    description: 'PROFILE_DETAILS_REQUIRED, GUARDIAN_NOT_REQUIRED or GUARDIAN_ALREADY_VERIFIED',
  })
  @ApiResponse({ status: 429, description: 'OTP_RESEND_TOO_SOON, OTP_PHONE_LIMIT_REACHED or OTP_IP_LIMIT_REACHED' })
  async requestGuardian(
    @Body({ schema: guardianSchema }) body: GuardianDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.users.requestGuardianConsent(user.id, body, client.ip);
  }

  @Post('me/guardian/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the guardian code and complete the profile',
    description: 'The code the guardian received. On success the profile is complete (profileNextStep = DONE).',
  })
  @ApiBody({
    schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', example: '123456' } } },
  })
  @ApiResponse({ status: 200, description: 'The completed profile.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED, OTP_INVALID or OTP_EXPIRED' })
  @ApiResponse({ status: 409, description: 'GUARDIAN_NOT_REQUESTED or GUARDIAN_ALREADY_VERIFIED' })
  @ApiResponse({ status: 429, description: 'OTP_ATTEMPTS_EXCEEDED' })
  async verifyGuardian(
    @Body({ schema: guardianVerifySchema }) body: GuardianVerifyDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.users.verifyGuardianConsent(user.id, body, client.ip);
  }
}