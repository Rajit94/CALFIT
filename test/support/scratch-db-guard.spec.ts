import { describe, expect, it } from 'vitest';
import { assertScratchDatabase } from './scratch-db-guard.js';

const url = (db: string, host = 'localhost') => `postgresql://user:SuperSecret!@${host}:5432/${db}`;

describe('assertScratchDatabase', () => {
  it('accepts calfit_scratch on localhost', () => {
    expect(assertScratchDatabase(url('calfit_scratch')).database).toBe('calfit_scratch');
  });

  it('accepts calfit_test', () => {
    expect(assertScratchDatabase(url('calfit_test')).database).toBe('calfit_test');
  });

  it('accepts 127.0.0.1 and ::1 as local hosts', () => {
    expect(() => assertScratchDatabase(url('calfit_scratch', '127.0.0.1'))).not.toThrow();
    expect(() => assertScratchDatabase(url('calfit_scratch', '[::1]'))).not.toThrow();
  });

  it('ignores query parameters such as ?schema=public', () => {
    expect(assertScratchDatabase(url('calfit_scratch') + '?schema=public').database).toBe(
      'calfit_scratch',
    );
  });

  it('refuses a missing or empty URL', () => {
    expect(() => assertScratchDatabase(undefined)).toThrow('TEST_DATABASE_URL is not set');
    expect(() => assertScratchDatabase('')).toThrow('TEST_DATABASE_URL is not set');
    expect(() => assertScratchDatabase('   ')).toThrow('TEST_DATABASE_URL is not set');
  });

  it('refuses the development database', () => {
    expect(() => assertScratchDatabase(url('calfit'))).toThrow('not an allowed test database');
  });

  it('refuses every other database name', () => {
    for (const name of ['calfit_prod', 'postgres', 'calfit_scratch_2', 'scratch', 'Calfit']) {
      expect(() => assertScratchDatabase(url(name))).toThrow('not an allowed test database');
    }
  });

  it('refuses a remote host even with an allowed database name', () => {
    expect(() => assertScratchDatabase(url('calfit_scratch', 'db.example.com'))).toThrow(
      'not a local host',
    );
  });

  it('refuses invalid URLs and other protocols', () => {
    expect(() => assertScratchDatabase('not a url')).toThrow('not a valid URL');
    expect(() => assertScratchDatabase('mysql://u:p@localhost/calfit_scratch')).toThrow(
      'must be a postgresql:// URL',
    );
  });

  it('never puts the password in an error message', () => {
    for (const bad of [url('calfit'), url('calfit_scratch', 'db.example.com'), 'postgresql://u:SuperSecret!@']) {
      try {
        assertScratchDatabase(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain('SuperSecret');
      }
    }
  });
});