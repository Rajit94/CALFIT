import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { ClientInfo } from '../auth/client-info.decorator.js';
import type { ClientDetails } from '../auth/client-info.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { parseWith } from '../common/validation/parse-with.js';
import { createPlanSchema, listPlansQuerySchema, updatePlanSchema } from './fees.schemas.js';
import type { CreatePlanDto, UpdatePlanDto } from './fees.schemas.js';
import { PlansService } from './plans.service.js';

// Every route is protected (no @Public()). Owner only.
@ApiTags('Fees')
@ApiBearerAuth()
@Controller('gyms/:gymId/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({
    summary: 'Membership plans (owner)',
    description: 'Active plans by default; includeInactive=true also lists deactivated ones. Prices are in rupees.',
  })
  @ApiQuery({ name: 'includeInactive', required: false, example: 'false' })
  @ApiResponse({ status: 200, description: '{ items: Plan[] }' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async list(
    @Param('gymId') gymId: string,
    @Query('includeInactive') includeInactive: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const query = parseWith(listPlansQuerySchema, { includeInactive });
    return this.plans.list(user.id, gymId, query.includeInactive);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a plan (owner)',
    description:
      'A plan lasts durationDays (a monthly plan is 30 days). The price is in rupees with at most 2 decimals, between 1 and 1,000,000. ' +
      'Plan names are unique within a gym, ignoring case. Up to 50 plans per gym.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'durationDays', 'price'],
      properties: {
        name: { type: 'string', example: 'Monthly' },
        description: { type: 'string', example: 'Access to all equipment' },
        durationDays: { type: 'integer', example: 30 },
        price: { type: 'number', example: 500 },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The plan.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 409, description: 'PLAN_NAME_TAKEN or PLAN_LIMIT_REACHED' })
  async create(
    @Param('gymId') gymId: string,
    @Body({ schema: createPlanSchema }) body: CreatePlanDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.plans.create(user.id, gymId, body, client.ip);
  }

  @Patch(':planId')
  @ApiOperation({
    summary: 'Edit or deactivate a plan (owner)',
    description:
      'Send only the fields to change. A new price or duration affects FUTURE fee cycles only; existing cycles keep their amount and dates. ' +
      'Plans are never deleted: set isActive to false instead.',
  })
  @ApiResponse({ status: 200, description: 'The updated plan.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or PLAN_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'PLAN_NAME_TAKEN' })
  async update(
    @Param('gymId') gymId: string,
    @Param('planId') planId: string,
    @Body({ schema: updatePlanSchema }) body: UpdatePlanDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.plans.update(user.id, gymId, planId, body, client.ip);
  }
}