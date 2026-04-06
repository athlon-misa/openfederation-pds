import { query } from '../db/client.js';

export type AuditAction =
  | 'account.approve'
  | 'account.reject'
  | 'account.register'
  | 'invite.create'
  | 'session.create'
  | 'session.refresh'
  | 'session.delete'
  | 'session.loginFailed'
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
  | 'account.export'
  | 'account.roles.update'
  | 'account.password.change'
  | 'account.password.reset.request'
  | 'account.password.reset.confirm'
  | 'identity.setExternalKey'
  | 'identity.deleteExternalKey'
  | 'community.updateMemberRole'
  | 'community.issueAttestation'
  | 'community.deleteAttestation'
  | 'admin.importRepo'
  | 'community.role.create'
  | 'community.role.update'
  | 'community.role.delete'
  | 'community.governance.setModel'
  | 'community.proposal.create'
  | 'community.proposal.vote'
  | 'community.proposal.approve'
  | 'community.proposal.reject'
  | 'community.proposal.expire'
  | 'admin.export.schedule.create'
  | 'admin.export.schedule.delete'
  | 'admin.export.snapshot.success'
  | 'admin.export.snapshot.failed'
  | 'community.proposal.amend'
  | 'community.delegation.set'
  | 'community.delegation.revoke'
  | 'session.revoke'
  | 'admin.verification.create'
  | 'admin.verification.failed'
  | 'admin.verification.success'
  | 'oracle.credential.create'
  | 'oracle.credential.revoke'
  | 'oracle.proofApplied'
  | 'identity.linkWallet'
  | 'identity.unlinkWallet'
  | 'account.recovery.initiate'
  | 'account.recovery.complete'
  | 'attestation.requestDisclosure'
  | 'attestation.createViewingGrant';

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
