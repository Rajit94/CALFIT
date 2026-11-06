// The signed-in person, as attached to the request by JwtAuthGuard.
export interface AuthUser {
  id: string; // users.id
  sessionId: string; // sessions.id (one per device)
}

// The parts of an HTTP request that the auth code touches.
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}