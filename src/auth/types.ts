import type { Request } from 'express';
import type { PartnerContext } from './partner-guard.js';

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'disabled' | 'suspended' | 'takendown' | 'deactivated';
export type UserRole = 'admin' | 'moderator' | 'partner-manager' | 'auditor' | 'user';
export type CommunityRole = 'owner' | 'moderator' | 'member';
export type CommunityStatus = 'active' | 'suspended' | 'takendown';

export interface AuthContext {
  userId: string;
  handle: string;
  email: string;
  did: string;
  status: UserStatus;
  roles: UserRole[];
  /** Incremented whenever previously issued local access JWTs must be revoked. */
  tokenVersion?: number;
  authMethod?: 'local' | 'oauth' | 'service-auth';
  /**
   * Whether users.email_verified_at is set. Loaded by authMiddleware ONLY
   * when EMAIL_VERIFICATION_POLICY needs it (require-for-*), fresh from the
   * database per request — a JWT claim would go stale the moment the user
   * verifies mid-session. Undefined under off/advisory.
   */
  emailVerified?: boolean;
}

export interface AuthRequest extends Request {
  auth?: AuthContext;
  authError?: 'missing' | 'invalid';
  /** Detailed service-auth error for the 'invalid' case. Used to return specific HTTP codes. */
  serviceAuthError?: { code: string; message: string; status: number };
  /** Set by authMiddleware when a valid X-Partner-Key header is present. */
  partnerAuth?: PartnerContext;
  /** Set by authMiddleware when X-Partner-Key is present but invalid/unverified. */
  partnerAuthError?: { status: number; code: string; message: string };
}
