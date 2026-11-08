import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from './auth.types.js';
import { ClientInfo } from './client-info.decorator.js';
import type { ClientDetails } from './client-info.decorator.js';
import { CurrentUser } from './current-user.decorator.js';
import { LogoutService } from './logout.service.js';
import { Public } from './public.decorator.js';
import { RefreshService } from './refresh.service.js';
import { refreshTokenSchema } from './session.schemas.js';
import type { RefreshTokenDto } from './session.schemas.js';

// refresh and logout are public: they are used when the access token has expired, and the
// refresh token in the body is their credential. logout-all has no @Public(), so it needs a
// valid access token.
@ApiTags('Auth')
@Controller('auth')
export class SessionController {
  constructor(
    private readonly refreshService: RefreshService,
    private readonly logoutService: LogoutService,
  ) {}

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Swap a refresh token for a new access token and a new refresh token',
    description:
      'Each refresh token works exactly once. Replace BOTH stored tokens with the new ones. ' +
      'The previous access token stops working immediately, so keep only one refresh request in flight ' +
      'and have waiting requests share its result. Sending a refresh token a second time is treated as theft ' +
      'and ends all of the user’s sessions. Any REFRESH_TOKEN_* error means: sign the user out.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'New tokens issued.',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        tokenType: { type: 'string', example: 'Bearer' },
        expiresIn: { type: 'number', example: 900 },
        refreshExpiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({
    status: 401,
    description: 'REFRESH_TOKEN_INVALID, REFRESH_TOKEN_EXPIRED or REFRESH_TOKEN_REUSED',
  })
  @ApiResponse({ status: 403, description: 'ACCOUNT_SUSPENDED or ACCOUNT_DELETED' })
  async refresh(
    @Body({ schema: refreshTokenSchema }) body: RefreshTokenDto,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.refreshService.refresh(body.refreshToken, client);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Sign out of this device',
    description:
      'Ends the session that the refresh token belongs to. Always answers 204, whether or not ' +
      'the token was known, so it reveals nothing. Delete the stored tokens on the device afterwards.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: { type: 'string' } },
    },
  })
  @ApiResponse({ status: 204, description: 'Signed out (or the token was already unusable).' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  async logout(@Body({ schema: refreshTokenSchema }) body: RefreshTokenDto): Promise<void> {
    await this.logoutService.logout(body.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sign out of every device',
    description:
      'Ends all of the signed-in user’s sessions, including this one: the access token used for this ' +
      'call stops working right afterwards. Delete the stored tokens on the device.',
  })
  @ApiResponse({
    status: 200,
    description: 'All sessions ended.',
    schema: { type: 'object', properties: { revokedSessions: { type: 'number', example: 3 } } },
  })
  @ApiResponse({
    status: 401,
    description: 'TOKEN_MISSING, TOKEN_INVALID, TOKEN_EXPIRED, SESSION_INVALID or SESSION_REVOKED',
  })
  @ApiResponse({ status: 403, description: 'ACCOUNT_SUSPENDED or ACCOUNT_DELETED' })
  async logoutAll(@CurrentUser() user: AuthUser) {
    return this.logoutService.logoutAll(user.id);
  }
}