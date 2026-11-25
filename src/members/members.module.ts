import { Module } from '@nestjs/common';
import { GymsModule } from '../gyms/gyms.module.js';
import { InvitationController } from './invitation.controller.js';
import { InvitationService } from './invitation.service.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { MembershipService } from './membership.service.js';

// GymsModule exports GymAccessService.
@Module({
  imports: [GymsModule],
  controllers: [MembersController, InvitationController],
  providers: [MembersService, MembershipService, InvitationService],
})
export class MembersModule {}