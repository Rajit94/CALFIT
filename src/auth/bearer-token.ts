export type BearerResult =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'ok'; token: string };

// Reads the token from an "Authorization: Bearer <token>" header.
export function extractBearerToken(header: string | string[] | undefined): BearerResult {
  if (header === undefined) return { status: 'missing' };
  if (Array.isArray(header)) return { status: 'malformed' };
  const value = header.trim();
  if (value === '') return { status: 'missing' };
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match?.[1] ? { status: 'ok', token: match[1] } : { status: 'malformed' };
}