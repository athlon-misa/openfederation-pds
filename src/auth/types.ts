import type { Request } from 'express';

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'disabled';
export type UserRole = 'admin' | 'moderator' | 'user';

export interface AuthContext {
  userId: string;
  handle: string;
  email: string;
  did: string;
  status: UserStatus;
  roles: UserRole[];
}

export interface AuthRequest extends Request {
  auth?: AuthContext;
  authError?: 'missing' | 'invalid';
}
