import { describe, expect, it } from 'vitest';
import { extractBearerToken } from './bearer-token.js';

describe('extractBearerToken', () => {
  it('returns the token for a well-formed header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toEqual({ status: 'ok', token: 'abc.def.ghi' });
  });

  it('is case-insensitive about the scheme', () => {
    expect(extractBearerToken('bearer abc')).toEqual({ status: 'ok', token: 'abc' });
    expect(extractBearerToken('BEARER abc')).toEqual({ status: 'ok', token: 'abc' });
  });

  it('reports missing for an absent, empty or blank header', () => {
    expect(extractBearerToken(undefined)).toEqual({ status: 'missing' });
    expect(extractBearerToken('')).toEqual({ status: 'missing' });
    expect(extractBearerToken('   ')).toEqual({ status: 'missing' });
  });

  it('reports malformed for a wrong scheme, extra parts or repeated headers', () => {
    expect(extractBearerToken('Basic abc')).toEqual({ status: 'malformed' });
    expect(extractBearerToken('Bearer')).toEqual({ status: 'malformed' });
    expect(extractBearerToken('Bearer a b')).toEqual({ status: 'malformed' });
    expect(extractBearerToken('abc.def.ghi')).toEqual({ status: 'malformed' });
    expect(extractBearerToken(['Bearer a', 'Bearer b'])).toEqual({ status: 'malformed' });
  });
});