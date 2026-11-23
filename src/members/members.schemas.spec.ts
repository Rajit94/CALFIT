import { describe, expect, it } from 'vitest';
import { addMemberSchema, listMembersQuerySchema, whatsappConsentSchema } from './members.schemas.js';

describe('listMembersQuerySchema', () => {
  it('applies the defaults', () => {
    const parsed = listMembersQuerySchema.parse({});
    expect(parsed).toMatchObject({ sort: 'name', limit: 50 });
    expect(parsed.status).toBeUndefined();
    expect(parsed.order).toBeUndefined();
  });

  it('accepts a status in any case, but not statuses that cannot be listed', () => {
    expect(listMembersQuerySchema.parse({ status: 'pending' }).status).toBe('PENDING');
    expect(listMembersQuerySchema.parse({ status: ' Removed ' }).status).toBe('REMOVED');
    for (const bad of ['REJECTED', 'GONE', '']) {
      expect(listMembersQuerySchema.safeParse({ status: bad }).success).toBe(false);
    }
  });

  it('validates sort and order', () => {
    expect(listMembersQuerySchema.safeParse({ sort: 'joinDate', order: 'desc' }).success).toBe(true);
    expect(listMembersQuerySchema.safeParse({ sort: 'age' }).success).toBe(false);
    expect(listMembersQuerySchema.safeParse({ order: 'up' }).success).toBe(false);
  });

  it('bounds the page size', () => {
    expect(listMembersQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    for (const bad of ['0', '101', 'abc', '2.5']) {
      expect(listMembersQuerySchema.safeParse({ limit: bad }).success).toBe(false);
    }
  });

  it('trims and limits the search text and the cursor', () => {
    expect(listMembersQuerySchema.parse({ q: '  asha ' }).q).toBe('asha');
    expect(listMembersQuerySchema.parse({ q: '   ' }).q).toBe('');
    expect(listMembersQuerySchema.safeParse({ q: 'x'.repeat(61) }).success).toBe(false);
    expect(listMembersQuerySchema.safeParse({ cursor: 'x'.repeat(401) }).success).toBe(false);
  });
});

describe('addMemberSchema', () => {
  it('accepts a name and an E.164 phone number, and tidies them', () => {
    expect(addMemberSchema.parse({ name: '  Asha   Rao ', phone: ' +919876543210 ' })).toEqual({
      name: 'Asha Rao',
      phone: '+919876543210',
    });
  });

  it('rejects bad or missing input', () => {
    expect(addMemberSchema.safeParse({ name: 'A', phone: '+919876543210' }).success).toBe(false);
    expect(addMemberSchema.safeParse({ name: 'Asha Rao', phone: '9876543210' }).success).toBe(false);
    expect(addMemberSchema.safeParse({ name: 'Asha Rao' }).success).toBe(false);
    expect(addMemberSchema.safeParse({ phone: '+919876543210' }).success).toBe(false);
  });
});

describe('whatsappConsentSchema', () => {
  it('needs a real boolean', () => {
    expect(whatsappConsentSchema.safeParse({ whatsappConsent: true }).success).toBe(true);
    expect(whatsappConsentSchema.safeParse({ whatsappConsent: false }).success).toBe(true);
    expect(whatsappConsentSchema.safeParse({ whatsappConsent: 'yes' }).success).toBe(false);
    expect(whatsappConsentSchema.safeParse({}).success).toBe(false);
  });
});