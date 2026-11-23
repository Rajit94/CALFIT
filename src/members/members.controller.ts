import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { ClientInfo } from '../auth/client-info.decorator.js';
import type { ClientDetails } from '../auth/client-info.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { parseWith } from '../common/validation/parse-with.js';
import { addMemberSchema, listMembersQuerySchema, whatsappConsentSchema } from './members.schemas.js';
import type { AddMemberDto, WhatsappConsentDto } from './members.schemas.js';
import { MembersService } from './members.service.js';
import { MembershipService } from './membership.service.js';

// Every route is protected (no @Public()). "members/summary" is declared before "members/:memberId".
@ApiTags('Members')
@ApiBearerAuth()
@Controller('gyms/:gymId')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly membership: MembershipService,
  ) {}

  @Get('members')
  @ApiOperation({
    summary: 'Member list (owner)',
    description:
      'Shows ACTIVE and INVITED members by default; use status=PENDING or status=REMOVED for the others (case-insensitive). ' +
      'q searches name, username and phone (phone only for ACTIVE and INVITED people). Full phone numbers are returned ' +
      'for ACTIVE and INVITED members and masked otherwise. sort=name sorts A-Z; sort=joinDate shows the newest first; ' +
      'people without a value come last. Keep the filters and sort unchanged while paging with nextCursor.',
  })
  @ApiQuery({ name: 'status', required: false, example: 'ACTIVE' })
  @ApiQuery({ name: 'q', required: false, example: 'asha' })
  @ApiQuery({ name: 'sort', required: false, example: 'name' })
  @ApiQuery({ name: 'order', required: false, example: 'asc' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: '{ items: Member[], nextCursor: string | null }' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async list(
    @Param('gymId') gymId: string,
    @Query('status') status: string | undefined,
    @Query('q') q: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('order') order: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const query = parseWith(listMembersQuerySchema, { status, q, sort, order, limit, cursor });
    return this.members.list(user.id, gymId, query);
  }

  @Get('members/summary')
  @ApiOperation({ summary: 'Member counts by status (owner)' })
  @ApiResponse({
    status: 200,
    description: '{ active, invited, pending, removed }',
    schema: {
      type: 'object',
      properties: {
        active: { type: 'integer' },
        invited: { type: 'integer' },
        pending: { type: 'integer' },
        removed: { type: 'integer' },
      },
    },
  })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async summary(@Param('gymId') gymId: string, @CurrentUser() user: AuthUser) {
    return this.members.summary(user.id, gymId);
  }

  @Get('members/:memberId')
  @ApiOperation({
    summary: 'One member (owner)',
    description:
      'Same fields as the list plus approvedAt, removedAt and whatsappConsentAt. Attendance and fee history will be added by their modules.',
  })
  @ApiResponse({ status: 200, description: 'The member.' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or MEMBER_NOT_FOUND' })
  async getMember(
    @Param('gymId') gymId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.members.getMember(user.id, gymId, memberId);
  }

  @Post('members')
  @ApiOperation({
    summary: 'Add a member by name and phone (owner)',
    description:
      'Creates an INVITED member. The answer never says whether the number belongs to a registered user. The person becomes ' +
      'ACTIVE automatically at their next sign-in or token refresh, or by joining with the gym code. A previously removed ' +
      'or rejected person is re-invited on the same record, and must accept WhatsApp reminders again.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'phone'],
      properties: {
        name: { type: 'string', example: 'Asha Rao' },
        phone: { type: 'string', example: '+919876543210' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The invited member.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'MEMBER_EXISTS' })
  async addMember(
    @Param('gymId') gymId: string,
    @Body({ schema: addMemberSchema }) body: AddMemberDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.members.add(user.id, gymId, body, client.ip);
  }

  @Delete('members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a member (owner)',
    description:
      'For ACTIVE and INVITED members. Their access ends on the next request and their WhatsApp consent is cleared. ' +
      'Fee history, check-ins and streak are kept. They can ask to join again after 7 days, or you can re-add them sooner.',
  })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or MEMBER_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'MEMBER_NOT_REMOVABLE' })
  async removeMember(
    @Param('gymId') gymId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ): Promise<void> {
    await this.members.remove(user.id, gymId, memberId, client.ip);
  }

  @Put('membership/whatsapp-consent')
  @ApiOperation({
    summary: 'Opt in or out of WhatsApp reminders for this gym (the member)',
    description:
      'For active members. Members added or imported by the owner start without consent and receive no reminders until they opt in. ' +
      'Works even when the gym is read-only, because withdrawing consent must always be possible.',
  })
  @ApiBody({
    schema: { type: 'object', required: ['whatsappConsent'], properties: { whatsappConsent: { type: 'boolean', example: true } } },
  })
  @ApiResponse({ status: 200, description: '{ whatsappConsent: boolean }' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or MEMBERSHIP_NOT_FOUND' })
  async setWhatsappConsent(
    @Param('gymId') gymId: string,
    @Body({ schema: whatsappConsentSchema }) body: WhatsappConsentDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.membership.setWhatsappConsent(user.id, gymId, body.whatsappConsent, client.ip);
  }
}