import { Module } from '@nestjs/common';
import { GymsModule } from '../gyms/gyms.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { MembershipService } from './membership.service.js';

// GymsModule exports GymAccessService.
@Module({
  imports: [GymsModule],
  controllers: [MembersController],
  providers: [MembersService, MembershipService],
})
export class MembersModule {}