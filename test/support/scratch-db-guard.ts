// The e2e tests write real rows, so they may only ever run against a scratch database.
export const ALLOWED_TEST_DATABASES = ['calfit_scratch', 'calfit_test'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

export interface ScratchDatabase {
  url: string;
  database: string;
}

// Throws unless the URL names an allowed test database on a local host.
// Error messages never include the URL, so a password cannot leak into logs.
export function assertScratchDatabase(rawUrl: string | undefined): ScratchDatabase {
  if (rawUrl === undefined || rawUrl.trim() === '') {
    throw new Error(
      'Refusing to run: TEST_DATABASE_URL is not set. Point it at the scratch database, e.g. ' +
        '$env:TEST_DATABASE_URL = "postgresql://USER:PASSWORD@localhost:5432/calfit_scratch"',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Refusing to run: TEST_DATABASE_URL is not a valid URL.');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Refusing to run: TEST_DATABASE_URL must be a postgresql:// URL.');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!ALLOWED_TEST_DATABASES.includes(database)) {
    throw new Error(
      `Refusing to run: database "${database}" is not an allowed test database ` +
        `(${ALLOWED_TEST_DATABASES.join(', ')}).`,
    );
  }

  if (!LOCAL_HOSTS.includes(parsed.hostname)) {
    throw new Error(`Refusing to run: host "${parsed.hostname}" is not a local host.`);
  }

  return { url: rawUrl.trim(), database };
}