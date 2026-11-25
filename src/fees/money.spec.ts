import { describe, expect, it } from 'vitest';
import { formatRupees, fromPaise, isWholePaise, toPaise } from './money.js';

describe('toPaise', () => {
  it('converts rupees to whole paise without floating-point drift', () => {
    expect(toPaise(499)).toBe(49900);
    expect(toPaise(499.99)).toBe(49999);
    expect(toPaise(0.07)).toBe(7);
    expect(toPaise(1234.5)).toBe(123450);
    expect(toPaise(0.1 + 0.2)).toBe(30);
    expect(toPaise(-300)).toBe(-30000);
  });

  it('accepts numeric strings and Decimal-like values', () => {
    expect(toPaise('12.50')).toBe(1250);
    expect(toPaise({ valueOf: () => '499.00' })).toBe(49900);
  });

  it('throws for values that are not numbers', () => {
    expect(() => toPaise('abc')).toThrow();
    expect(() => toPaise(Number.NaN)).toThrow();
    expect(() => toPaise(undefined)).toThrow();
  });
});

describe('fromPaise, isWholePaise, formatRupees', () => {
  it('converts back and formats', () => {
    expect(fromPaise(49999)).toBe(499.99);
    expect(fromPaise(-30000)).toBe(-300);
    expect(formatRupees(30000)).toBe('Rs 300.00');
    expect(formatRupees(12345)).toBe('Rs 123.45');
  });

  it('recognises amounts with at most two decimals', () => {
    for (const ok of [1, 10.5, 499.99, 0.01, 100.1]) expect(isWholePaise(ok)).toBe(true);
    for (const bad of [10.555, 0.001, Number.NaN, Number.POSITIVE_INFINITY]) expect(isWholePaise(bad)).toBe(false);
  });
});