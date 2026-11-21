import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GymAccessService } from './gym-access.service.js';
import { GymsController } from './gyms.controller.js';
import { GymsService } from './gyms.service.js';
import { HolidaysService } from './holidays.service.js';
import { JoinRequestsService } from './join-requests.service.js';

// AuthModule exports ParentalConsentPolicy (used for the adult-age rule).
// GymAccessService is exported: later modules (members, fees, check-in) use it for access checks.
@Module({
  imports: [AuthModule],
  controllers: [GymsController],
  providers: [GymAccessService, GymsService, JoinRequestsService, HolidaysService],
  exports: [GymAccessService],
})
export class GymsModule {}