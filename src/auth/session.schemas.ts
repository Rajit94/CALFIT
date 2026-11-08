import { z } from 'zod';

// Body of POST /auth/refresh and POST /auth/logout.
// The token's exact format is checked in the service, so the answer is a 401 rather than a 400.
export const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(1, 'refreshToken is required').max(512),
});
export type RefreshTokenDto = z.infer<typeof refreshTokenSchema>;