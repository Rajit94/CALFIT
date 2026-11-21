import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { ClientInfo } from '../auth/client-info.decorator.js';
import type { ClientDetails } from '../auth/client-info.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { parseWith } from '../common/validation/parse-with.js';
import { GymsService } from './gyms.service.js';
import { HolidaysService } from './holidays.service.js';
import { JoinRequestsService } from './join-requests.service.js';
import {
  addHolidaySchema,
  createGymSchema,
  gymCodeQuerySchema,
  gymCodeSchema,
  holidayRangeSchema,
  joinGymSchema,
  joinRequestsQuerySchema,
  updateGymSchema,
} from './gyms.schemas.js';
import type { AddHolidayDto, CreateGymDto, JoinGymDto, UpdateGymDto } from './gyms.schemas.js';

// Every route is protected (no @Public()). Static routes (preview, join) are declared before the ":gymId" routes.
@ApiTags('Gyms')
@ApiBearerAuth()
@Controller('gyms')
export class GymsController {
  constructor(
    private readonly gyms: GymsService,
    private readonly joins: JoinRequestsService,
    private readonly holidays: HolidaysService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a gym',
    description:
      'Needs a completed profile and an age of 18 or more; up to 3 gyms per person. Creates the gym, your OWNER ' +
      'membership, a free trial of two calendar months (then Rs 499/month, 1,000 WhatsApp messages) and default reminder ' +
      'settings in one step. The response includes the join code. Send timings as {"mon":[["06:00","10:00"]]}; {} clears them.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'city', 'latitude', 'longitude'],
      properties: {
        name: { type: 'string', example: "Gold's Gym" },
        description: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string', example: 'Jabalpur' },
        state: { type: 'string' },
        pincode: { type: 'string', example: '482001' },
        latitude: { type: 'number', example: 23.1815 },
        longitude: { type: 'number', example: 79.9864 },
        checkInRadiusM: { type: 'integer', example: 150, description: '50-500 metres' },
        timings: { type: 'object', example: { mon: [['06:00', '10:00'], ['17:00', '22:00']] } },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The gym, including code and subscription (you are the owner).' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_OWNER_MUST_BE_ADULT or GYM_LIMIT_REACHED' })
  @ApiResponse({ status: 409, description: 'PROFILE_NOT_COMPLETED' })
  async create(
    @Body({ schema: createGymSchema }) body: CreateGymDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.gyms.create(user.id, body, client.ip);
  }

  @Get('preview')
  @ApiOperation({
    summary: 'Preview a gym by its code, before asking to join',
    description:
      'Shows name, description, address, member count and your own relationship to the gym. Codes are 6 characters ' +
      'and are accepted in any case, with or without a hyphen.',
  })
  @ApiQuery({ name: 'code', required: true, example: 'K7M2QX' })
  @ApiResponse({ status: 200, description: 'The preview.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async preview(@Query('code') code: string | undefined, @CurrentUser() user: AuthUser) {
  const { code: parsedCode } = parseWith(gymCodeQuerySchema, { code });
  return this.gyms.preview(user.id, parsedCode);
}

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask to join a gym with its code',
    description:
      'Needs a completed profile. The owner must approve the request (status PENDING). The answer to whatsappConsent is ' +
      'recorded; declining does not stop you from joining. Owners joining their own gym, and people the owner already ' +
      'imported by phone number, are activated at once (autoApproved). After a rejection or removal you can ask again after 7 days.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code', 'whatsappConsent'],
      properties: {
        code: { type: 'string', example: 'K7M2QX' },
        whatsappConsent: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'The result.',
    schema: {
      type: 'object',
      properties: {
        gymId: { type: 'string', format: 'uuid' },
        gymName: { type: 'string' },
        status: { type: 'string', enum: ['PENDING', 'ACTIVE'] },
        autoApproved: { type: 'boolean' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_READ_ONLY' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'PROFILE_NOT_COMPLETED, ALREADY_MEMBER or JOIN_REQUEST_PENDING' })
  @ApiResponse({ status: 429, description: 'JOIN_REQUEST_TOO_SOON' })
  async join(
    @Body({ schema: joinGymSchema }) body: JoinGymDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.joins.join(user.id, body, client.ip);
  }

  @Get(':gymId')
  @ApiOperation({
    summary: 'Gym details (active members of the gym)',
    description:
      'Owners also get the join code, the number of pending requests and the subscription (trial status and days left). ' +
      'People who are not active members get 404.',
  })
  @ApiResponse({ status: 200, description: 'The gym.' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async getGym(@Param('gymId') gymId: string, @CurrentUser() user: AuthUser) {
    return this.gyms.getForUser(user.id, gymId);
  }

  @Patch(':gymId')
  @ApiOperation({
    summary: 'Edit the gym profile (owner)',
    description:
      'Send only the fields to change. latitude and longitude go together. code, status and the subscription cannot be ' +
      'changed here. Refused when the gym is read-only or suspended.',
  })
  @ApiResponse({ status: 200, description: 'The updated gym.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async updateGym(
    @Param('gymId') gymId: string,
    @Body({ schema: updateGymSchema }) body: UpdateGymDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.gyms.update(user.id, gymId, body, client.ip);
  }

  @Get(':gymId/join-requests')
  @ApiOperation({
    summary: 'Pending join requests (owner)',
    description: 'Oldest first. Phone numbers are masked until the request is approved. Use nextCursor for the next page.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: 'items and nextCursor.' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async listJoinRequests(
    @Param('gymId') gymId: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.joins.list(user.id, gymId, parseWith(joinRequestsQuerySchema, { limit, cursor }));
  }

  @Post(':gymId/join-requests/:memberId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a join request (owner)' })
  @ApiResponse({ status: 200, description: '{ memberId, status: "ACTIVE" }' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or JOIN_REQUEST_NOT_FOUND' })
  async approve(
    @Param('gymId') gymId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.joins.decide(user.id, gymId, memberId, 'approve', client.ip);
  }

  @Post(':gymId/join-requests/:memberId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a join request (owner)',
    description: 'The person can ask again after 7 days.',
  })
  @ApiResponse({ status: 200, description: '{ memberId, status: "REJECTED" }' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or JOIN_REQUEST_NOT_FOUND' })
  async reject(
    @Param('gymId') gymId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.joins.decide(user.id, gymId, memberId, 'reject', client.ip);
  }

  @Get(':gymId/holidays')
  @ApiOperation({
    summary: 'Holidays (active members of the gym)',
    description: 'Defaults to today through the next 365 days. Holidays never break a streak.',
  })
  @ApiQuery({ name: 'from', required: false, example: '2026-11-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-12-31' })
  @ApiResponse({ status: 200, description: '{ items: [{ id, date, reason }] }' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async listHolidays(
    @Param('gymId') gymId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.holidays.list(user.id, gymId, parseWith(holidayRangeSchema, { from, to }));
  }

  @Post(':gymId/holidays')
  @ApiOperation({
    summary: 'Declare a holiday (owner)',
    description: 'From today up to 365 days ahead. The past cannot be changed, because it would rewrite streaks.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['date'],
      properties: {
        date: { type: 'string', format: 'date', example: '2026-11-14' },
        reason: { type: 'string', example: 'Diwali' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The holiday.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED or HOLIDAY_DATE_INVALID' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 409, description: 'HOLIDAY_EXISTS' })
  async addHoliday(
    @Param('gymId') gymId: string,
    @Body({ schema: addHolidaySchema }) body: AddHolidayDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.holidays.add(user.id, gymId, body, client.ip);
  }

  @Delete(':gymId/holidays/:holidayId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a holiday (owner)',
    description: 'Only holidays after today can be removed.',
  })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or HOLIDAY_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'HOLIDAY_LOCKED' })
  async removeHoliday(
    @Param('gymId') gymId: string,
    @Param('holidayId') holidayId: string,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ): Promise<void> {
    await this.holidays.remove(user.id, gymId, holidayId, client.ip);
  }
}