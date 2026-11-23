import { z } from 'zod';
import { phoneSchema } from '../auth/validation.js';
import { nameSchema } from '../users/users.schemas.js';

// REJECTED people are not listed here: their requests were declined and they have no membership.
export const LISTABLE_STATUSES = ['ACTIVE', 'INVITED', 'PENDING', 'REMOVED'] as const;
export type ListableStatus = (typeof LISTABLE_STATUSES)[number];

export const listMembersQuerySchema = z.object({
  status: z.string().trim().toUpperCase().pipe(z.enum(LISTABLE_STATUSES)).optional(),
  q: z.string().trim().max(60, 'Search text can be at most 60 characters').optional(),
  sort: z.enum(['name', 'joinDate']).default('name'),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(400).optional(),
});
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

export const addMemberSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
});
export type AddMemberDto = z.infer<typeof addMemberSchema>;

export const whatsappConsentSchema = z.object({
  whatsappConsent: z.boolean(),
});
export type WhatsappConsentDto = z.infer<typeof whatsappConsentSchema>;