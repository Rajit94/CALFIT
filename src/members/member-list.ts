import { maskPhone } from '../auth/validation.js';
import { issuesToException } from '../common/validation/validation-pipe.js';

export interface MemberRowInput {
  id: string;
  status: string;
  userId: string | null;
  invitedName: string | null;
  invitedPhone: string | null;
  joinedAt: Date | null;
  approvedAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
  whatsappConsent: boolean;
  whatsappConsentAt: Date | null;
  user: { name: string | null; username: string | null; avatarUrl: string | null; phone: string } | null;
}

export interface MemberItem {
  memberId: string;
  userId: string | null;
  status: string;
  registered: boolean; // linked to a CALFIT account
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  phone: string | null; // full number only for ACTIVE and INVITED members
  phoneMasked: string | null;
  joinedAt: string | null;
  addedAt: string;
  whatsappConsent: boolean;
}

export interface MemberDetail extends MemberItem {
  approvedAt: string | null;
  removedAt: string | null;
  whatsappConsentAt: string | null;
}

// The owner sees a full number only for people who are in the gym or whom the owner invited.
const FULL_PHONE_STATUSES = new Set(['ACTIVE', 'INVITED']);

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toMemberItem(row: MemberRowInput): MemberItem {
  const rawPhone = row.user?.phone ?? row.invitedPhone;
  return {
    memberId: row.id,
    userId: row.userId,
    status: row.status,
    registered: row.userId !== null,
    name: row.user?.name ?? row.invitedName,
    username: row.user?.username ?? null,
    avatarUrl: row.user?.avatarUrl ?? null,
    phone: rawPhone && FULL_PHONE_STATUSES.has(row.status) ? rawPhone : null,
    phoneMasked: rawPhone ? maskPhone(rawPhone) : null,
    joinedAt: iso(row.joinedAt),
    addedAt: row.createdAt.toISOString(),
    whatsappConsent: row.whatsappConsent,
  };
}

export function toMemberDetail(row: MemberRowInput): MemberDetail {
  return {
    ...toMemberItem(row),
    approvedAt: iso(row.approvedAt),
    removedAt: iso(row.removedAt),
    whatsappConsentAt: iso(row.whatsappConsentAt),
  };
}

const digitsOf = (value: string): string => value.replace(/\D/g, '');

// Phones are searched only when they are visible, so a hidden number cannot be recovered by searching.
export function matchesSearch(item: MemberItem, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  if (item.name?.toLowerCase().includes(query)) return true;
  if (item.username?.toLowerCase().includes(query)) return true;
  const queryDigits = digitsOf(query);
  return queryDigits.length >= 3 && item.phone !== null && digitsOf(item.phone).includes(queryDigits);
}

export type SortField = 'name' | 'joinDate';
export type SortOrder = 'asc' | 'desc';

export interface PageOptions {
  sort: SortField;
  order: SortOrder;
  limit: number;
  cursor?: string | undefined;
}

interface SortKey {
  group: 0 | 1; // 1 = no value; those rows always come last
  value: string;
  id: string;
}

function keyFor(item: MemberItem, sort: SortField): SortKey {
  const value = sort === 'name' ? item.name?.toLowerCase() : item.joinedAt;
  return value ? { group: 0, value, id: item.memberId } : { group: 1, value: '', id: item.memberId };
}

function compareKeys(a: SortKey, b: SortKey, order: SortOrder): number {
  if (a.group !== b.group) return a.group - b.group;
  if (a.value !== b.value) {
    const result = a.value < b.value ? -1 : 1;
    return order === 'desc' ? -result : result;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // ties: by id, always ascending
}

interface CursorPayload {
  s: string; // sort and order, so a cursor cannot be reused with different settings
  g: 0 | 1;
  v: string;
  i: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor: string, scope: string): SortKey {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Partial<CursorPayload>;
      if (p.s === scope && (p.g === 0 || p.g === 1) && typeof p.v === 'string' && typeof p.i === 'string') {
        return { group: p.g, value: p.v, id: p.i };
      }
    }
  } catch {
    /* fall through to the error below */
  }
  throw issuesToException([{ message: 'Invalid cursor', path: ['cursor'] }]);
}

// The cursor holds the sort position of the last item, not just its id, so paging keeps working
// even if that member is removed between two requests.
export function paginateMembers(
  items: MemberItem[],
  options: PageOptions,
): { items: MemberItem[]; nextCursor: string | null } {
  const { sort, order, limit } = options;
  const scope = `${sort}:${order}`;
  const keyed = items
    .map((item) => ({ item, key: keyFor(item, sort) }))
    .sort((a, b) => compareKeys(a.key, b.key, order));

  let start = 0;
  if (options.cursor) {
    const after = decodeCursor(options.cursor, scope);
    start = keyed.findIndex((entry) => compareKeys(entry.key, after, order) > 0);
    if (start === -1) start = keyed.length;
  }

  const page = keyed.slice(start, start + limit);
  const last = page[page.length - 1];
  const hasMore = start + limit < keyed.length;
  return {
    items: page.map((entry) => entry.item),
    nextCursor:
      hasMore && last
        ? encodeCursor({ s: scope, g: last.key.group, v: last.key.value, i: last.key.id })
        : null,
  };
}