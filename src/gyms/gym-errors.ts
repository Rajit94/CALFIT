import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

export const gymNotFound = (): NotFoundException =>
  new NotFoundException({ code: 'GYM_NOT_FOUND', message: 'Gym not found.' });

export const gymForbidden = (): ForbiddenException =>
  new ForbiddenException({
    code: 'GYM_FORBIDDEN',
    message: 'You do not have permission to do this in this gym.',
  });

export const gymReadOnly = (): ForbiddenException =>
  new ForbiddenException({
    code: 'GYM_READ_ONLY',
    message: 'This gym is read-only because its subscription is not active.',
  });

export const gymSuspended = (): ForbiddenException =>
  new ForbiddenException({ code: 'GYM_SUSPENDED', message: 'This gym has been suspended.' });

export const profileNotCompleted = (): ConflictException =>
  new ConflictException({
    code: 'PROFILE_NOT_COMPLETED',
    message: 'Finish setting up your profile first.',
  });

export const sessionInvalid = (): UnauthorizedException =>
  new UnauthorizedException({ code: 'SESSION_INVALID', message: 'This session is no longer valid.' });

export const conflict = (code: string, message: string): ConflictException =>
  new ConflictException({ code, message });

export const tooMany = (code: string, message: string): HttpException =>
  new HttpException({ code, message }, HttpStatus.TOO_MANY_REQUESTS);