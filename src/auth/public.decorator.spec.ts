import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY, Public } from './public.decorator.js';

describe('Public decorator', () => {
  const reflector = new Reflector();

  it('marks a handler as public', () => {
    const handler = () => undefined;
    Public()(handler as never);
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
  });

  it('leaves other handlers unmarked', () => {
    const handler = () => undefined;
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBeUndefined();
  });
});