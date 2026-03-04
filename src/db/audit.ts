import { query } from '../db/client.js';

export type AuditAction =
  | 'account.approve'
  | 'account.reject'
  | 'account.register'
  | 'invite.create'
  | 'session.create'
  | 'session.refresh'
  | 'session.delete'
  | 'community.create'
  | 'community.update'
  | 'community.join'
  | 'community.leave'
  | 'community.export'
  | 'community.suspend'
  | 'community.unsuspend'
  | 'community.takedown'
  | 'community.transfer.initiate'
  | 'community.removeMember'
  | 'community.delete'
  | 'join_request.approve'
  | 'join_request.reject'
  | 'community.linkApplication'
  | 'community.unlinkApplication'
  | 'partner.register'
  | 'partner.key.create'
  | 'partner.key.revoke'
  | 'account.suspend'
  | 'account.unsuspend'
  | 'account.takedown'
  | 'account.deactivate'
  | 'account.activate'
  | 'account.delete'
  | 'account.export';

export async function auditLog(
  action: AuditAction,
  actorId: string | null,
  targetId: string | null,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (action, actor_id, target_id, meta)
       VALUES ($1, $2, $3, $4)`,
      [action, actorId, targetId, meta ? JSON.stringify(meta) : null]
    );
  } catch (err) {
    // Audit logging should never crash the request
    console.error('Failed to write audit log:', err);
  }
}
