import { BadRequestException, StandardSchemaValidationPipe } from '@nestjs/common';

// The part of a Standard Schema issue we need.
export interface SchemaIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined;
}

function segment(part: PropertyKey | { key: PropertyKey }): string {
  return typeof part === 'object' ? String(part.key) : String(part);
}

export function issuesToException(issues: ReadonlyArray<SchemaIssue>): BadRequestException {
  const details = issues.map((issue) => {
    const field = (issue.path ?? []).map(segment).join('.');
    return field ? { field, message: issue.message } : { message: issue.message };
  });
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'Validation failed',
    details,
  });
}

export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) => issuesToException(issues),
  });
}