import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { indexRsvp, CALENDAR_RSVP, CALENDAR_EVENT } from '../forum/forum-index.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { writeMemberContent, deleteMemberContent, isPrivateCommunity } from '../forum/member-content.js';

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
      req as AuthRequest & { auth: AuthContext }, res, community, 'community.calendar.write'
    );
    if (!hasPermission) return;

    // The permission above was checked against `community`, so the event must
    // be one of that community's: otherwise membership of any community would
    // let you put yourself on the attendee list of any other.
    const eventPrefix = `at://${community}/${CALENDAR_EVENT}/`;
    const eventRkey = event.uri.startsWith(eventPrefix) ? event.uri.slice(eventPrefix.length) : '';
    const eventExists = eventRkey !== '' && (await query(
      'SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [community, CALENDAR_EVENT, eventRkey],
    )).rows.length > 0;
    if (!eventExists) {
      res.status(400).json({ error: 'InvalidRequest', message: 'event is not an event of this community' });
      return;
    }

    const attendeeDid = req.auth!.did;
    const createdAt = new Date().toISOString();
    const record = { subject: event, status, createdAt };

    // Changing your mind replaces your RSVP; it does not add another. (Each
    // call used to leave one more record behind in the repository.)
    const previous = await query<{ uri: string }>(
      'SELECT uri FROM event_rsvps WHERE event_uri = $1 AND attendee_did = $2',
      [event.uri, attendeeDid],
    );
    const wantPrivate = await isPrivateCommunity(community);
    const previousUri = previous.rows[0]?.uri;
    const previousInPlace = previousUri
      && previousUri.startsWith(`at://${wantPrivate ? community : attendeeDid}/${CALENDAR_RSVP}/`);
    if (previousUri && !previousInPlace) await deleteMemberContent(previousUri).catch(() => undefined);

    const result = await writeMemberContent({
      communityDid: community, authorDid: attendeeDid, collection: CALENDAR_RSVP, record,
      private: wantPrivate,
      ...(previousInPlace ? { rkey: previousUri!.split('/').pop() } : {}),
    });
    const rkey = result.rkey;

    await indexRsvp({ uri: result.uri, eventUri: event.uri, attendeeDid, status, createdAt });
    await auditLog('calendar.rsvp', req.auth!.userId, community, { uri: result.uri, event: event.uri, status });
    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in calendar.rsvp:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to RSVP' });
  }
}
