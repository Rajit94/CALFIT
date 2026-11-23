import { describe, expect, it } from 'vitest';
import { matchesSearch, paginateMembers, toMemberDetail, toMemberItem } from './member-list.js';
import type { MemberItem, MemberRowInput } from './member-list.js';

const row = (over: Partial<MemberRowInput> = {}): MemberRowInput => ({
  id: 'm1',
  status: 'ACTIVE',
  userId: 'u1',
  invitedName: null,
  invitedPhone: null,
  joinedAt: new Date('2026-10-01T00:00:00.000Z'),
  approvedAt: null,
  removedAt: null,
  createdAt: new Date('2026-09-30T00:00:00.000Z'),
  whatsappConsent: false,
  whatsappConsentAt: null,
  user: { name: 'Rajit Kumar', username: 'rajit.k', avatarUrl: null, phone: '+919876543210' },
  ...over,
});

// A named, linked member (name null = an unnamed invited row).
const mk = (id: string, name: string | null, joinedAt: string | null = null, status = 'ACTIVE'): MemberItem =>
  toMemberItem(
    row({
      id,
      status,
      userId: name ? `u-${id}` : null,
      joinedAt: joinedAt ? new Date(joinedAt) : null,
      invitedPhone: name ? null : '+919000000000',
      user: name ? { name, username: null, avatarUrl: null, phone: `+91900000${id.padStart(4, '0')}` } : null,
    }),
  );

const opts = (over: Record<string, unknown> = {}) => ({ sort: 'name' as const, order: 'asc' as const, limit: 10, ...over });
const ids = (items: MemberItem[]) => items.map((i) => i.memberId);

function validationCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { getResponse: () => { code?: string } }).getResponse().code;
  }
  return undefined;
}

describe('toMemberItem and toMemberDetail', () => {
  it('maps a registered active member with a full phone number', () => {
    expect(toMemberItem(row())).toEqual({
      memberId: 'm1',
      userId: 'u1',
      status: 'ACTIVE',
      registered: true,
      name: 'Rajit Kumar',
      username: 'rajit.k',
      avatarUrl: null,
      phone: '+919876543210',
      phoneMasked: '+91******3210',
      joinedAt: '2026-10-01T00:00:00.000Z',
      addedAt: '2026-09-30T00:00:00.000Z',
      whatsappConsent: false,
    });
  });

  it('maps an invited member who has no account yet', () => {
    const item = toMemberItem(
      row({ id: 'm2', status: 'INVITED', userId: null, user: null, invitedName: 'Imported Ravi', invitedPhone: '+919000000001', joinedAt: null }),
    );
    expect(item).toMatchObject({
      registered: false, userId: null, name: 'Imported Ravi', username: null,
      phone: '+919000000001', phoneMasked: '+91******0001', joinedAt: null,
    });
  });

  it('hides the full number for pending, removed and rejected people', () => {
    for (const status of ['PENDING', 'REMOVED', 'REJECTED']) {
      const item = toMemberItem(row({ status }));
      expect(item.phone).toBeNull();
      expect(item.phoneMasked).toBe('+91******3210');
      expect(JSON.stringify(item)).not.toContain('+919876543210');
    }
  });

  it('falls back to the invited name when the linked user has no name', () => {
    const item = toMemberItem(
      row({ invitedName: 'Fallback Name', user: { name: null, username: null, avatarUrl: null, phone: '+919876543210' } }),
    );
    expect(item.name).toBe('Fallback Name');
  });

  it('adds the extra dates to the detail view', () => {
    const detail = toMemberDetail(
      row({
        approvedAt: new Date('2026-10-02T00:00:00.000Z'),
        removedAt: new Date('2026-10-03T00:00:00.000Z'),
        whatsappConsentAt: new Date('2026-10-04T00:00:00.000Z'),
      }),
    );
    expect(detail).toMatchObject({
      approvedAt: '2026-10-02T00:00:00.000Z',
      removedAt: '2026-10-03T00:00:00.000Z',
      whatsappConsentAt: '2026-10-04T00:00:00.000Z',
    });
    expect(toMemberDetail(row()).approvedAt).toBeNull();
  });
});

describe('matchesSearch', () => {
  const item = toMemberItem(row());

  it('matches an empty query', () => {
    expect(matchesSearch(item, '')).toBe(true);
    expect(matchesSearch(item, '   ')).toBe(true);
  });

  it('matches name and username, ignoring case', () => {
    expect(matchesSearch(item, 'RAJIT')).toBe(true);
    expect(matchesSearch(item, 'kum')).toBe(true);
    expect(matchesSearch(item, 'rajit.k')).toBe(true);
    expect(matchesSearch(item, 'nobody')).toBe(false);
  });

  it('matches phone digits, with or without the country code and punctuation', () => {
    expect(matchesSearch(item, '98765')).toBe(true);
    expect(matchesSearch(item, '+91 98765 43210')).toBe(true);
    expect(matchesSearch(item, '99999')).toBe(false);
  });

  it('ignores digit queries shorter than three digits', () => {
    expect(matchesSearch(item, '98')).toBe(false);
  });

  it('never matches a phone number that is hidden from the owner', () => {
    const pending = toMemberItem(row({ status: 'PENDING', user: { name: 'Pam', username: null, avatarUrl: null, phone: '+919876543210' } }));
    expect(matchesSearch(pending, '9876543210')).toBe(false);
    expect(matchesSearch(pending, 'pam')).toBe(true);
  });
});

describe('paginateMembers', () => {
  it('sorts by name case-insensitively, with unnamed rows last in both directions', () => {
    const items = [mk('3', 'charlie'), mk('1', 'Alpha'), mk('2', 'bravo'), mk('9', null)];
    expect(ids(paginateMembers(items, opts()).items)).toEqual(['1', '2', '3', '9']);
    expect(ids(paginateMembers(items, opts({ order: 'desc' })).items)).toEqual(['3', '2', '1', '9']);
  });

  it('sorts by join date, with people who have not joined last', () => {
    const items = [
      mk('a', 'A', '2026-10-01T00:00:00.000Z'),
      mk('b', 'B', '2026-10-03T00:00:00.000Z'),
      mk('c', 'C', null),
      mk('d', 'D', '2026-10-02T00:00:00.000Z'),
    ];
    expect(ids(paginateMembers(items, opts({ sort: 'joinDate', order: 'desc' })).items)).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(paginateMembers(items, opts({ sort: 'joinDate', order: 'asc' })).items)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('breaks ties by id, always ascending', () => {
    const items = [mk('2', 'Sam'), mk('1', 'Sam')];
    expect(ids(paginateMembers(items, opts()).items)).toEqual(['1', '2']);
    expect(ids(paginateMembers(items, opts({ order: 'desc' })).items)).toEqual(['1', '2']);
  });

  it('pages through every item exactly once', () => {
    const items = ['e', 'c', 'a', 'd', 'b'].map((n, i) => mk(String(i + 1), n));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = paginateMembers(items, opts({ limit: 2, cursor }));
      seen.push(...page.items.map((i) => i.name as string));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps paging correctly when the next member disappears between two requests', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((n, i) => mk(String(i + 1), n));
    const first = paginateMembers(items, opts({ limit: 2 }));
    const without = items.filter((i) => i.name !== 'c');
    const second = paginateMembers(without, opts({ limit: 2, cursor: first.nextCursor ?? undefined }));
    expect(second.items.map((i) => i.name)).toEqual(['d', 'e']);
    expect(second.nextCursor).toBeNull();
  });

  it('returns no cursor when the last page is exactly full', () => {
    const items = ['a', 'b', 'c', 'd'].map((n, i) => mk(String(i + 1), n));
    const first = paginateMembers(items, opts({ limit: 2 }));
    expect(first.nextCursor).not.toBeNull();
    const second = paginateMembers(items, opts({ limit: 2, cursor: first.nextCursor ?? undefined }));
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor', () => {
    const items = [mk('1', 'a')];
    for (const cursor of ['garbage', Buffer.from('{"x":1}').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      expect(validationCode(() => paginateMembers(items, opts({ cursor })))).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a cursor created with a different sort or direction', () => {
    const items = ['a', 'b', 'c'].map((n, i) => mk(String(i + 1), n));
    const cursor = paginateMembers(items, opts({ limit: 1 })).nextCursor as string;
    expect(validationCode(() => paginateMembers(items, opts({ limit: 1, order: 'desc', cursor })))).toBe('VALIDATION_FAILED');
    expect(validationCode(() => paginateMembers(items, opts({ limit: 1, sort: 'joinDate', cursor })))).toBe('VALIDATION_FAILED');
  });
});