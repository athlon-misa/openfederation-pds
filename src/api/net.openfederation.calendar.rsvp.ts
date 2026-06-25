import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { indexRsvp, CALENDAR_RSVP } from '../forum/forum-index.js';
import { auditLog } from '../db/audit.js';

const STATUSES = ['going', 'interested', 'notgoing'];

function isStrongRef(v: unknown): v is { uri: string; cid: string } {
  return !!v && typeof v === 'object'
    && typeof (v as { uri?: unknown }).uri === 'string'
    && typeof (v as { cid?: unknown }).cid === 'string';
}

export default async function rsvp(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { community, event, status } = req.body;
    if (!community || !isStrongRef(event) || !STATUSES.includes(status)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community, event {uri,cid}, and a valid status are required' });
      return;
    }
    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, community, 'community.forum.write'
    );
    if (!hasPermission) return;

    const attendeeDid = req.auth!.did;
    const engine = new RepoEngine(attendeeDid); // RSVP lives in the ATTENDEE's repo
    const keypair = await getKeypairForDid(attendeeDid);
    const rkey = RepoEngine.generateTid();
    const createdAt = new Date().toISOString();
    const record = { subject: event, status, createdAt };
    const result = await engine.putRecord(keypair, CALENDAR_RSVP, rkey, record);

    await indexRsvp({ uri: result.uri, eventUri: event.uri, attendeeDid, status, createdAt });
    await auditLog('calendar.rsvp', req.auth!.userId, community, { uri: result.uri, event: event.uri, status });
    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in calendar.rsvp:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to RSVP' });
  }
}
