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
  | 'community.reverseTakedown'
  | 'community.takedownExpired'
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
  | 'partner.key.verified'
  | 'partner.key.verifyFailed'
  | 'account.suspend'
  | 'account.unsuspend'
  | 'account.takedown'
  | 'account.reverseTakedown'
  | 'account.takedownExpired'
  | 'account.deactivate'
  | 'account.activate'
  | 'account.migrateIn'
  | 'community.migrateIn'
  | 'community.activate'
  | 'community.moved'
  | 'community.movedKeys.served'
  | 'identity.plcSignature.request'
  | 'identity.plcSignature.refused'
  | 'identity.plcSignature.signed'
  | 'identity.plcOperation.submitted'
  | 'identity.custodyChange'
  | 'account.deviceSigning.enable'
  | 'account.deviceSigning.disable'
  | 'server.settings.update'
  | 'identity.assistedRecovery'
  | 'account.delete'
  | 'account.export'
  | 'account.roles.update'
  | 'account.password.change'
  | 'account.password.reset.request'
  | 'account.password.reset.confirm'
  | 'identity.setExternalKey'
  | 'identity.deleteExternalKey'
  | 'community.updateMember'
  | 'community.issueAttestation'
  | 'community.deleteAttestation'
  | 'admin.importRepo'
  | 'community.role.create'
  | 'community.role.update'
  | 'community.role.delete'
  | 'community.governance.setModel'
  | 'community.proposal.create'
  | 'community.proposal.vote'
  | 'community.proposal.vote.recordFailed'
  | 'community.proposal.approve'
  | 'community.proposal.reject'
  | 'community.proposal.expire'
  | 'community.proposal.resolution.deferred'
  // Timelock: decided, waiting out the contest window, then applied or held.
  | 'community.proposal.pendingApplication'
  | 'community.proposal.objection'
  | 'community.proposal.applicationHeld'
  // Email: an address added to the suppression list by a provider webhook (#83).
  | 'email.suppression.add'
  | 'account.email.verified'
  // The override round a hold opens (#199): its outcome either way.
  | 'community.proposal.overrideOpened'
  | 'community.proposal.overrideCarried'
  | 'community.proposal.overrideExpired'
  | 'community.proposal.overrideCloseFailed'
  | 'community.proposal.apply'
  | 'community.proposal.applyFailed'
  | 'community.proposal.decision.superseded'
  // Anchoring: a decision notarized externally, or an attempt that failed and
  // will be retried. Never a precondition of the decision itself.
  | 'community.proposal.decision.anchored'
  | 'community.proposal.decision.anchorFailed'
  | 'admin.export.schedule.create'
  | 'admin.export.schedule.delete'
  | 'admin.export.snapshot.success'
  | 'admin.export.snapshot.failed'
  | 'community.proposal.amend'
  | 'community.delegation.set'
  | 'community.delegation.revoke'
  | 'session.revoke'
  | 'session.reuseDetected'
  | 'admin.verification.create'
  | 'admin.verification.failed'
  | 'admin.verification.success'
  | 'oracle.credential.create'
  | 'oracle.credential.revoke'
  | 'oracle.proofAuthorized'
  | 'oracle.proofApplied'
  | 'identity.linkWallet'
  | 'identity.unlinkWallet'
  | 'wallet.provision'
  | 'wallet.sign'
  | 'wallet.signTransaction'
  | 'wallet.consent.grant'
  | 'wallet.consent.request'
  | 'wallet.consent.deny'
  | 'wallet.consent.revoke'
  // Refused because the declared dApp origin did not match the Origin the
  // request came from — the attempted impersonation is the thing worth keeping.
  | 'wallet.sign.originRejected'
  | 'wallet.signTransaction.originRejected'
  | 'wallet.consent.originRejected'
  // Login handoff code presented by a browser that did not start the flow (#146).
  | 'auth.external.handoffRejected'
  | 'identity.signInAssert'
  | 'identity.setPrimaryWallet'
  | 'wallet.retrieveForUpgrade'
  | 'wallet.retrieveForUpgradeFailed'
  | 'wallet.tierChange'
  | 'account.recovery.initiate'
  | 'account.recovery.complete'
  | 'attestation.requestDisclosure'
  | 'attestation.createViewingGrant'
  | 'disclosure.redeem'
  | 'disclosure.revoke'
  | 'forum.thread.create'
  | 'forum.import'
  | 'forum.post.create'
  | 'forum.post.delete'
  | 'forum.post.hide'
  | 'forum.post.unhide'
  | 'forum.thread.hide'
  | 'forum.thread.unhide'
  | 'calendar.event.create'
  | 'calendar.rsvp';

export async function auditLog(
  action: AuditAction,
  actorId: string | null,
  targetId: string | null,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    // Pseudonym rule: no audit trail for pseudonyms, ever. Enforced here so
    // no call site can forget. One statement, no extra round trip.
    //
    // The entry is dropped when a pseudonym is the actor, the target, or is
    // named by a top-level string in the metadata. That last case matters:
    // community actions record the community as the target and the member in
    // the metadata (`memberDid`, `subjectDid`, ...), which wrote a pseudonym's
    // DID next to a timestamp just as surely as naming it as the target would.
    await query(
      `INSERT INTO audit_log (action, actor_id, target_id, meta)
       SELECT $1, $2::varchar, $3::varchar, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM users u WHERE u.auth_type = 'pseudonym'
           AND (u.id = $2::varchar OR u.id = $3::varchar OR u.did = $3::varchar
                OR u.did IN (SELECT e.value FROM jsonb_each_text(
                     CASE WHEN jsonb_typeof($4::jsonb) = 'object' THEN $4::jsonb ELSE '{}'::jsonb END) AS e))
       )`,
      [action, actorId, targetId, meta ? JSON.stringify(meta) : null],
    );
  } catch (err) {
    // Audit logging should never crash the request
    console.error('Failed to write audit log:', err);
  }
}

/**
 * Fire-and-forget variant of auditLog. Does not await the INSERT.
 * Use for non-security-critical paths where response speed matters
 * more than guaranteed audit delivery.
 *
 * IMPORTANT: Do NOT use for security-critical events like failed logins,
 * session revocations, or password changes — those must use the awaited
 * `auditLog()` to ensure the audit trail is written before responding.
 */
export function auditLogAsync(
  action: AuditAction,
  actorId: string | null,
  targetId: string | null,
  meta?: Record<string, unknown>
): void {
  auditLog(action, actorId, targetId, meta);
}
