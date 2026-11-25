import { Module } from '@nestjs/common';
import { GymsModule } from '../gyms/gyms.module.js';
import { FeesController } from './fees.controller.js';
import { FeesService } from './fees.service.js';
import { PaymentsService } from './payments.service.js';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

// GymsModule exports GymAccessService.
@Module({
  imports: [GymsModule],
  controllers: [PlansController, FeesController],
  providers: [PlansService, FeesService, PaymentsService],
})
export class FeesModule {}