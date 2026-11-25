import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { ClientInfo } from '../auth/client-info.decorator.js';
import type { ClientDetails } from '../auth/client-info.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { parseWith } from '../common/validation/parse-with.js';
import { FeesService } from './fees.service.js';
import {
  assignFeeSchema,
  listFeesQuerySchema,
  reasonBodySchema,
  recordPaymentSchema,
} from './fees.schemas.js';
import type { AssignFeeDto, ReasonBodyDto, RecordPaymentDto } from './fees.schemas.js';
import { PaymentsService } from './payments.service.js';

// Every route is protected (no @Public()). All amounts are in rupees. Owner only, except "membership/fees".
// Fee status values: PENDING, PARTIAL, PAID, OVERDUE (worked out from the due date, in IST), WAIVED.
@ApiTags('Fees')
@ApiBearerAuth()
@Controller('gyms/:gymId')
export class FeesController {
  constructor(
    private readonly fees: FeesService,
    private readonly payments: PaymentsService,
  ) {}

  @Post('members/:memberId/fees')
  @ApiOperation({
    summary: 'Assign a plan to a member: creates one fee cycle (owner)',
    description:
      'The cycle starts on startDate and lasts the plan duration. A renewal is the same call with the next start date. ' +
      'dueDate defaults to startDate (it may be up to 30 days earlier, and not after the cycle ends). amount defaults to the ' +
      'plan price; a different amount needs an amountReason (kept in the audit log). A member cannot have overlapping cycles ' +
      '(waived cycles do not count). Works for ACTIVE and INVITED members.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['planId', 'startDate'],
      properties: {
        planId: { type: 'string', format: 'uuid' },
        startDate: { type: 'string', format: 'date', example: '2026-11-04' },
        dueDate: { type: 'string', format: 'date', example: '2026-11-10' },
        amount: { type: 'number', example: 400, description: 'Rupees. Needs amountReason when different from the plan price.' },
        amountReason: { type: 'string', example: 'Student discount' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'The fee, with its (empty) payment list.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND, MEMBER_NOT_FOUND or PLAN_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'MEMBER_NOT_BILLABLE, PLAN_INACTIVE or FEE_PERIOD_OVERLAP' })
  async assignFee(
    @Param('gymId') gymId: string,
    @Param('memberId') memberId: string,
    @Body({ schema: assignFeeSchema }) body: AssignFeeDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.fees.assign(user.id, gymId, memberId, body, client.ip);
  }

  @Get('fees')
  @ApiOperation({
    summary: 'Fee list (owner)',
    description:
      'Ordered by due date, oldest first. Filter by status (case-insensitive), memberId and a due-date range. ' +
      'Phone numbers follow the member-list rules. Use nextCursor for the next page and keep the filters unchanged.',
  })
  @ApiQuery({ name: 'status', required: false, example: 'OVERDUE' })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'dueFrom', required: false, example: '2026-11-01' })
  @ApiQuery({ name: 'dueTo', required: false, example: '2026-11-30' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResponse({ status: 200, description: '{ items: Fee[], nextCursor: string | null }' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND' })
  async listFees(
    @Param('gymId') gymId: string,
    @Query('status') status: string | undefined,
    @Query('memberId') memberId: string | undefined,
    @Query('dueFrom') dueFrom: string | undefined,
    @Query('dueTo') dueTo: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const query = parseWith(listFeesQuerySchema, { status, memberId, dueFrom, dueTo, limit, cursor });
    return this.fees.list(user.id, gymId, query);
  }

  @Get('fees/:feeId')
  @ApiOperation({
    summary: 'One fee with its payments (owner)',
    description:
      'payments lists every payment and reversal entry. Reversal entries have a negative amount, a receipt number starting with "X-" ' +
      'and reversesReceiptNo; a payment that has been reversed has reversed=true.',
  })
  @ApiResponse({ status: 200, description: 'The fee.' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or FEE_NOT_FOUND' })
  async getFee(
    @Param('gymId') gymId: string,
    @Param('feeId') feeId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fees.get(user.id, gymId, feeId);
  }

  @Post('fees/:feeId/payments')
  @ApiOperation({
    summary: 'Record a payment (owner)',
    description:
      'Partial payments are allowed; a payment above the balance is refused. method is CASH, UPI, CARD, BANK_TRANSFER or OTHER. ' +
      'paidAt defaults to now and may be up to 30 days in the past (a date, or a date-time with a time zone). Receipt numbers ' +
      'run per gym (R-000001...). Payments cannot be edited or deleted: use the reversal endpoint. Works for removed members\' open fees too.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['amount', 'method'],
      properties: {
        amount: { type: 'number', example: 200 },
        method: { type: 'string', enum: ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'] },
        paidAt: { type: 'string', example: '2026-11-03' },
        note: { type: 'string', example: 'Paid at the desk' },
      },
    },
  })
  @ApiResponse({ status: 201, description: '{ payment, fee }: the new receipt and the updated fee.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or FEE_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'FEE_WAIVED, FEE_ALREADY_PAID, PAYMENT_EXCEEDS_BALANCE, FEE_CHANGED or RECEIPT_NUMBER_BUSY',
  })
  async recordPayment(
    @Param('gymId') gymId: string,
    @Param('feeId') feeId: string,
    @Body({ schema: recordPaymentSchema }) body: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.payments.record(user.id, gymId, feeId, body, client.ip);
  }

  @Post('fees/:feeId/payments/:paymentId/reverse')
  @ApiOperation({
    summary: 'Reverse a payment (owner)',
    description:
      'Adds a negative entry with its own receipt number (X-000001...) and a required reason, and recalculates the fee. ' +
      'A payment can be reversed once; reversal entries cannot be reversed; waived fees cannot be changed.',
  })
  @ApiBody({
    schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', example: 'Entered the wrong amount' } } },
  })
  @ApiResponse({ status: 201, description: '{ payment, fee }: the reversal entry and the updated fee.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND, FEE_NOT_FOUND or PAYMENT_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'FEE_WAIVED, PAYMENT_NOT_REVERSIBLE, PAYMENT_ALREADY_REVERSED, FEE_CHANGED or RECEIPT_NUMBER_BUSY',
  })
  async reversePayment(
    @Param('gymId') gymId: string,
    @Param('feeId') feeId: string,
    @Param('paymentId') paymentId: string,
    @Body({ schema: reasonBodySchema }) body: ReasonBodyDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.payments.reverse(user.id, gymId, feeId, paymentId, body.reason, client.ip);
  }

  @Post('fees/:feeId/waive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Waive the remaining balance (owner)',
    description:
      'Needs a reason (kept in the audit log). The fee becomes WAIVED: it keeps what was already paid, the rest is forgiven, ' +
      'and it can no longer take payments or be changed.',
  })
  @ApiBody({
    schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', example: 'Member injured' } } },
  })
  @ApiResponse({ status: 200, description: 'The fee.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 403, description: 'GYM_FORBIDDEN, GYM_READ_ONLY or GYM_SUSPENDED' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or FEE_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'FEE_ALREADY_WAIVED, FEE_ALREADY_PAID or FEE_CHANGED' })
  async waiveFee(
    @Param('gymId') gymId: string,
    @Param('feeId') feeId: string,
    @Body({ schema: reasonBodySchema }) body: ReasonBodyDto,
    @CurrentUser() user: AuthUser,
    @ClientInfo() client: ClientDetails,
  ) {
    return this.payments.waive(user.id, gymId, feeId, body.reason, client.ip);
  }

  @Get('membership/fees')
  @ApiOperation({
    summary: 'My fees and receipts (the member)',
    description: 'The signed-in member\'s own fees, newest cycle first, each with its payments and receipts. Active members only.',
  })
  @ApiResponse({ status: 200, description: '{ items: MyFee[] }' })
  @ApiResponse({ status: 404, description: 'GYM_NOT_FOUND or MEMBERSHIP_NOT_FOUND' })
  async myFees(@Param('gymId') gymId: string, @CurrentUser() user: AuthUser) {
    return this.fees.myFees(user.id, gymId);
  }
}