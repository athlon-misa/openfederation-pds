import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { CALENDAR_EVENT } from '../forum/forum-index.js';
import { auditLog } from '../db/audit.js';

export default async function createEvent(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { community, name, description, startsAt, endsAt, mode, status, location } = req.body;
    if (!community || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community and name are required' });
      return;
    }
    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, community, 'community.calendar.write'
    );
    if (!hasPermission) return;

    const engine = new RepoEngine(community); // event lives in the COMMUNITY repo
    const keypair = await getKeypairForDid(community);
    const rkey = RepoEngine.generateTid();
    const record: Record<string, unknown> = {
      name: name.trim(), createdAt: new Date().toISOString(),
      ...(description ? { description } : {}),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
      ...(mode ? { mode } : {}),
      ...(status ? { status } : {}),
      ...(location ? { location } : {}),
    };
    const result = await engine.putRecord(keypair, CALENDAR_EVENT, rkey, record);
    await auditLog('calendar.event.create', req.auth!.userId, community, { uri: result.uri });
    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in calendar.createEvent:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create event' });
  }
}
