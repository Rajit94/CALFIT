import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { ClientInfo } from '../auth/client-info.decorator.js';
import type { ClientDetails } from '../auth/client-info.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { acceptInvitationSchema } from '../fees/fees.schemas.js';
import type { AcceptInvitationDto } from '../fees/fees.schemas.js';
import { InvitationService } from './invitation.service.js';

// Protected (no @Public()). Used by the invited person themselves.
@ApiTags('Members')
@ApiBearerAuth()
@Controller('gyms/:gymId/membership')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation to a gym (the invited person)',
    description:
      'For a registered person whose membership is INVITED, for example after the owner removed and re-added them. ' +
      'No gym code is needed. The WhatsApp answer is recorded; declining does not stop you from joining. ' +
      'People added by the owner who have no account yet are activated automatically at their next sign-in.',
  })
  @ApiBody({
    schema: { type: 'object', required: ['whatsappConsent'], properties: { whatsappConsent: { type: 'boolean', example: true } } },
  })
  @ApiResponse({ status: 200, description: '{ gymId, gymName, status: "ACTIVE" }' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_READ_ONLY' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'ALREADY_MEMBER' })
  async accept(
    @Param('gymId') gymId: string,
    @Body({ schema: acceptInvitationSchema }) body: AcceptInvitationDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.invitations.accept(user.id, gymId, body.whatsappConsent, client.ip);
  }
}