import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

describe('envSchema', () => {
  const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/calfit' };

  it('applies defaults', () => {
    const env = envSchema.parse(base);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT to a number', () => {
    expect(envSchema.parse({ ...base, PORT: '4000' }).PORT).toBe(4000);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(envSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(envSchema.safeParse({ DATABASE_URL: 'mysql://x/y' }).success).toBe(false);
  });
});