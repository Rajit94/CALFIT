import type { z } from 'zod';
import { issuesToException } from './validation-pipe.js';

// For query-string values, which the global schema pipe does not validate.
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw issuesToException(
      result.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
    );
  }
  return result.data as z.output<S>;
}