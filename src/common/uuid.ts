const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Used to turn malformed ids in URLs into a clean 404 instead of a database error.
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);