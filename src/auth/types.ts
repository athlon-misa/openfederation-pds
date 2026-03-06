import type { Request } from 'express';

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
  authMethod?: 'local' | 'oauth';
}

export interface AuthRequest extends Request {
  auth?: AuthContext;
  authError?: 'missing' | 'invalid';
}
