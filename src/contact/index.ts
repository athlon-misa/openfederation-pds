import { query, withAdvisoryLock } from '../db/client.js';
import { fullHandle } from '../auth/utils.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { assertMayWriteFor, isDeviceSigningOn } from '../repo/device-signing-state.js';
import { writeRepoAs, actingDevice } from '../repo/device-actions.js';
import type { AuthContext } from '../auth/types.js';
import { resolveDisplayFields, batchResolveOptionalDisplayFields } from '../community/display-projection.js';
import { createNotification } from '../notification/index.js';

/** Longest note a contact request may carry (matches the lexicon). */
const MAX_NOTE_LENGTH = 280;

const REQUEST_COLLECTION = 'net.openfederation.contact.request';
const CONTACT_COLLECTION = 'net.openfederation.contact.contact';
const BLOCK_COLLECTION   = 'net.openfederation.contact.block';

export async function sendContactRequest(
  auth: AuthContext,
  subject: string,
  note?: string,
): Promise<{ rkey: string; uri: string; cid: string }> {
  const callerDid = auth.did;

  if (!callerDid) throw Object.assign(new Error('No DID on caller'), { code: 'InvalidRequest', status: 400 });
  if (!subject || !subject.startsWith('did:')) throw Object.assign(new Error('Invalid subject DID'), { code: 'InvalidRequest', status: 400 });
  if (subject === callerDid) throw Object.assign(new Error('Cannot send a contact request to yourself'), { code: 'InvalidRequest', status: 400 });
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    throw Object.assign(new Error(`note must be text of at most ${MAX_NOTE_LENGTH} characters`), { code: 'InvalidRequest', status: 400 });
  }
  // The request is a record in the caller's repo (#240: their device signs it,
  // through net.openfederation.repo.prepareAction, when device signing is on).
  await assertMayWriteFor(callerDid);

  // A request can only be accepted by an account on this PDS (acceptance
  // writes to both repositories), so one addressed to anything else can never
  // complete. Refusing it also stops requests and their notifications being
  // created for arbitrary or invented DIDs.
  const recipient = await query<{ handle: string }>('SELECT handle FROM users WHERE did = $1', [subject]);
  if (recipient.rows.length === 0) {
    throw Object.assign(new Error('No account with that DID on this server'), { code: 'NotFound', status: 404 });
  }

  // Check for blocks in either direction
  const blockCheck = await query(
    `SELECT 1 FROM contact_blocks
      WHERE (blocker_did = $1 AND blocked_did = $2) OR (blocker_did = $2 AND blocked_did = $1)
     LIMIT 1`,
    [callerDid, subject],
  );
  if (blockCheck.rows.length > 0) {
    throw Object.assign(
      new Error('Cannot send a contact request: one party has blocked the other'),
      { code: 'Blocked', status: 403 },
    );
  }

  // Check for existing request or contact in either direction
  const conflict = await query(
    `SELECT 1 FROM contact_requests
      WHERE (from_did = $1 AND to_did = $2) OR (from_did = $2 AND to_did = $1)
     UNION ALL
     SELECT 1 FROM contacts
      WHERE (user_did = $1 AND contact_did = $2) OR (user_did = $2 AND contact_did = $1)
     LIMIT 1`,
    [callerDid, subject],
  );
  if (conflict.rows.length > 0) {
    throw Object.assign(
      new Error('A pending request or accepted contact already exists between these users'),
      { code: 'AlreadyExists', status: 409 },
    );
  }

  const record = {
    subject,
    createdAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  };

  const [result] = await writeRepoAs(callerDid, [{ action: 'write', collection: REQUEST_COLLECTION, rkey: RepoEngine.generateTid(), record }]);
  const rkey = result.rkey;
  const issuedAt = String(result.record?.createdAt ?? record.createdAt);

  // Get recipient's handle for the index
  const recipientRow = await query<{ handle: string }>(
    'SELECT handle FROM users WHERE did = $1',
    [subject],
  );
  const toHandle = fullHandle(recipientRow.rows[0]?.handle) ?? subject;

  await query(
    `INSERT INTO contact_requests (from_did, to_did, rkey, note, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [callerDid, subject, rkey, note ?? null, issuedAt],
  );

  // Notify the recipient (#70)
  await createNotification(subject, 'contact-request', {
    fromDid: callerDid,
    fromHandle: fullHandle(auth.handle) ?? callerDid,
    rkey,
    ...(note ? { note } : {}),
  }).catch(() => { /* non-critical */ });

  return { rkey, uri: result.uri, cid: result.cid! };
}

export async function respondToContactRequest(
  auth: AuthContext,
  rkey: string,
  action: 'accept' | 'reject',
): Promise<void> {
  const callerDid = auth.did;
  if (!callerDid) throw Object.assign(new Error('No DID'), { code: 'InvalidRequest', status: 400 });
  if (action !== 'accept' && action !== 'reject') {
    throw Object.assign(new Error("action must be 'accept' or 'reject'"), { code: 'InvalidRequest', status: 400 });
  }

  // One response at a time per request. Accepting writes a contact record to
  // each of two repositories, removes the request record and updates the
  // index; two responses running together each did all of that. Under the
  // lock the second finds the request already gone.
  await withAdvisoryLock(`contact-request:${callerDid}:${rkey}`, async () => {
    const reqRow = await query<{ from_did: string }>(
      'SELECT from_did FROM contact_requests WHERE to_did = $1 AND rkey = $2',
      [callerDid, rkey],
    );
    if (reqRow.rows.length === 0) {
      throw Object.assign(new Error('No incoming request with the given rkey'), { code: 'NotFound', status: 404 });
    }
    const { from_did: fromDid } = reqRow.rows[0];

    // Accepting writes a contact record into both repos. The caller's is
    // written first: under device signing (#240) their device signs it
    // (prepareAction), and nothing else has changed until it has.
    if (action === 'accept') await assertMayWriteFor(callerDid);

    // Every step below checks whether it has already been done, and the
    // request row is removed last. If something fails part-way the request is
    // still there, and responding again finishes the job without repeating
    // the steps that succeeded.
    if (action === 'accept') {
      const acceptedAt = new Date().toISOString();
      await ensureContact(callerDid, fromDid, acceptedAt);
      const theirs = await query(
        'SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>\'subject\' = $3 LIMIT 1',
        [fromDid, CONTACT_COLLECTION, callerDid],
      );
      if (theirs.rows.length === 0 && await isDeviceSigningOn(fromDid) && !actingDevice(fromDid)) {
        // The requester's device signs their repo, and only it can add their
        // side. They are asked to confirm: a request from the caller, which
        // their device accepts like any other (the caller's side is already
        // there, so accepting it writes only theirs).
        await askToConfirmContact(callerDid, fromDid, auth);
      } else {
        await ensureContact(fromDid, callerDid, acceptedAt);
      }
    }

    // Remove the request record from the requester's repo, if it is still there.
    const requestRecord = await query(
      'SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [fromDid, REQUEST_COLLECTION, rkey],
    );
    // If the requester's device signs their repo (#240), their request record
    // stays for their device to delete; the request itself is still resolved.
    if (requestRecord.rows.length > 0 && !(await isDeviceSigningOn(fromDid))) {
      await writeRepoAs(fromDid, [{ action: 'delete', collection: REQUEST_COLLECTION, rkey }]);
    }

    await query('DELETE FROM contact_requests WHERE to_did = $1 AND rkey = $2', [callerDid, rkey]);
  });
}

/**
 * The other half of accepting a request from someone whose device signs their
 * repo (#240): a pending request from `accepterDid` to them, with no record
 * behind it (the accepter's contact record already says what it would). It
 * shows as an incoming request; accepting it on their device writes their
 * contact record.
 */
async function askToConfirmContact(accepterDid: string, requesterDid: string, auth: AuthContext): Promise<void> {
  const rkey = RepoEngine.generateTid();
  const inserted = await query(
    `INSERT INTO contact_requests (from_did, to_did, rkey, note, created_at)
     VALUES ($1, $2, $3, NULL, NOW())
     ON CONFLICT DO NOTHING`,
    [accepterDid, requesterDid, rkey],
  );
  if ((inserted.rowCount ?? 0) === 0) return;
  await createNotification(requesterDid, 'contact-request', {
    fromDid: accepterDid,
    fromHandle: fullHandle(auth.handle) ?? accepterDid,
    rkey,
    confirm: true,
  }).catch(() => { /* non-critical */ });
}

/**
 * Make sure `ownerDid` has a contact record naming `contactDid`, and that the
 * index says so. Does nothing that is already done: an existing record is
 * reused, not duplicated.
 */
async function ensureContact(ownerDid: string, contactDid: string, acceptedAt: string): Promise<void> {
  const existing = await query<{ rkey: string }>(
    `SELECT rkey FROM records_index
     WHERE community_did = $1 AND collection = $2 AND record->>'subject' = $3
     ORDER BY rkey LIMIT 1`,
    [ownerDid, CONTACT_COLLECTION, contactDid],
  );
  let contactRkey = existing.rows[0]?.rkey;
  if (!contactRkey) {
    const [written] = await writeRepoAs(ownerDid, [{
      action: 'write', collection: CONTACT_COLLECTION, rkey: RepoEngine.generateTid(),
      record: { subject: contactDid, acceptedAt },
    }]);
    contactRkey = written.rkey;
    if (typeof written.record?.acceptedAt === 'string') acceptedAt = written.record.acceptedAt;
  }
  await query(
    `INSERT INTO contacts (user_did, contact_did, rkey, accepted_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [ownerDid, contactDid, contactRkey, acceptedAt],
  );
}

export async function removeContact(auth: AuthContext, subject: string): Promise<void> {
  const callerDid = auth.did;
  if (!callerDid) throw Object.assign(new Error('No DID'), { code: 'InvalidRequest', status: 400 });
  if (!subject) throw Object.assign(new Error('Missing subject'), { code: 'InvalidRequest', status: 400 });

  // Look up both sides
  const callerRow = await query<{ rkey: string }>(
    'SELECT rkey FROM contacts WHERE user_did = $1 AND contact_did = $2',
    [callerDid, subject],
  );
  if (callerRow.rows.length === 0) {
    throw Object.assign(new Error('No accepted contact relationship with the given DID'), { code: 'NotFound', status: 404 });
  }
  const callerContactRkey = callerRow.rows[0].rkey;
  // The caller's contact record is in their repo (#240: their device signs
  // the deletion, through prepareAction, when device signing is on).
  await assertMayWriteFor(callerDid);

  const subjectRow = await query<{ rkey: string }>(
    'SELECT rkey FROM contacts WHERE user_did = $1 AND contact_did = $2',
    [subject, callerDid],
  );

  // Delete caller's contact record from their repo
  await writeRepoAs(callerDid, [{ action: 'delete', collection: CONTACT_COLLECTION, rkey: callerContactRkey }]);

  // Cooperatively remove from counterpart's repo if record exists
  if (subjectRow.rows.length > 0) {
    try {
      await writeRepoAs(subject, [{ action: 'delete', collection: CONTACT_COLLECTION, rkey: subjectRow.rows[0].rkey }]);
    } catch {
      // Counterpart repo may be on a remote PDS, or signed by their device
      // (#240) — best effort
    }
    await query(
      'DELETE FROM contacts WHERE user_did = $1 AND contact_did = $2',
      [subject, callerDid],
    );
  }

  await query(
    'DELETE FROM contacts WHERE user_did = $1 AND contact_did = $2',
    [callerDid, subject],
  );
}

export async function listContacts(
  auth: AuthContext,
  limit: number,
  cursor?: string,
): Promise<{ contacts: unknown[]; cursor?: string }> {
  const callerDid = auth.did;
  if (!callerDid) throw Object.assign(new Error('No DID'), { code: 'InvalidRequest', status: 400 });

  let sql = `
    SELECT c.contact_did, c.rkey, c.accepted_at, c.tags,
           u.handle
    FROM contacts c
    LEFT JOIN users u ON u.did = c.contact_did
    WHERE c.user_did = $1`;
  const params: (string | number)[] = [callerDid];
  let paramIdx = 2;

  if (cursor) {
    sql += ` AND c.rkey > $${paramIdx}`;
    params.push(cursor);
    paramIdx++;
  }

  sql += ` ORDER BY c.rkey ASC LIMIT $${paramIdx}`;
  params.push(limit + 1);

  const result = await query<{
    contact_did: string;
    rkey: string;
    accepted_at: Date;
    tags: string[] | null;
    handle: string | null;
  }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].rkey;
  }

  const displayMap = await batchResolveOptionalDisplayFields(rows.map(r => r.contact_did));

  const contacts = rows.map(row => {
    const display = displayMap.get(row.contact_did) ?? {};
    return {
      did: row.contact_did,
      handle: fullHandle(row.handle) ?? row.contact_did,
      ...(display.displayName ? { displayName: display.displayName } : {}),
      ...(display.avatarUrl ? { avatarUrl: display.avatarUrl } : {}),
      acceptedAt: new Date(row.accepted_at).toISOString(),
      ...(Array.isArray(row.tags) && row.tags.length > 0 ? { tags: row.tags } : {}),
    };
  });

  return {
    contacts,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export async function listIncomingRequests(
  auth: AuthContext,
  limit: number,
  cursor?: string,
): Promise<{ requests: unknown[]; cursor?: string }> {
  const callerDid = auth.did;
  if (!callerDid) throw Object.assign(new Error('No DID'), { code: 'InvalidRequest', status: 400 });

  let sql = `
    SELECT cr.from_did, cr.rkey, cr.note, cr.created_at,
           u.handle
    FROM contact_requests cr
    LEFT JOIN users u ON u.did = cr.from_did
    WHERE cr.to_did = $1`;
  const params: (string | number)[] = [callerDid];
  let paramIdx = 2;

  if (cursor) {
    sql += ` AND cr.rkey > $${paramIdx}`;
    params.push(cursor);
    paramIdx++;
  }

  sql += ` ORDER BY cr.created_at ASC LIMIT $${paramIdx}`;
  params.push(limit + 1);

  const result = await query<{
    from_did: string;
    rkey: string;
    note: string | null;
    created_at: Date;
    handle: string | null;
  }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].rkey;
  }

  const displayMap = await batchResolveOptionalDisplayFields(rows.map(r => r.from_did));

  const requests = rows.map(row => {
    const display = displayMap.get(row.from_did) ?? {};
    return {
      rkey: row.rkey,
      fromDid: row.from_did,
      fromHandle: fullHandle(row.handle) ?? row.from_did,
      ...(display.displayName ? { fromDisplayName: display.displayName } : {}),
      ...(display.avatarUrl ? { fromAvatarUrl: display.avatarUrl } : {}),
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.note ? { note: row.note } : {}),
    };
  });

  return {
    requests,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export async function listOutgoingRequests(
  auth: AuthContext,
  limit: number,
  cursor?: string,
): Promise<{ requests: unknown[]; cursor?: string }> {
  const callerDid = auth.did;
  if (!callerDid) throw Object.assign(new Error('No DID'), { code: 'InvalidRequest', status: 400 });

  let sql = `
    SELECT cr.to_did, cr.rkey, cr.note, cr.created_at,
           u.handle
    FROM contact_requests cr
    LEFT JOIN users u ON u.did = cr.to_did
    WHERE cr.from_did = $1`;
  const params: (string | number)[] = [callerDid];
  let paramIdx = 2;

  if (cursor) {
    sql += ` AND cr.rkey > $${paramIdx}`;
    params.push(cursor);
    paramIdx++;
  }

  sql += ` ORDER BY cr.created_at ASC LIMIT $${paramIdx}`;
  params.push(limit + 1);

  const result = await query<{
    to_did: string;
    rkey: string;
    note: string | null;
    created_at: Date;
    handle: string | null;
  }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].rkey;
  }

  const displayMap = await batchResolveOptionalDisplayFields(rows.map(r => r.to_did));

  const requests = rows.map(row => {
    const display = displayMap.get(row.to_did) ?? {};
    return {
      rkey: row.rkey,
      toDid: row.to_did,
      toHandle: fullHandle(row.handle) ?? row.to_did,
      ...(display.displayName ? { toDisplayName: display.displayName } : {}),
      ...(display.avatarUrl ? { toAvatarUrl: display.avatarUrl } : {}),
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.note ? { note: row.note } : {}),
    };
  });

  return {
    requests,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

// ── #68 withdrawRequest ──────────────────────────────────────────────────────

export async function withdrawContactRequest(
  auth: AuthContext,
  rkey: string,
): Promise<void> {
  const callerDid = auth.did!;

  const row = await query<{ to_did: string }>(
    'SELECT to_did FROM contact_requests WHERE from_did = $1 AND rkey = $2',
    [callerDid, rkey],
  );
  if (row.rows.length === 0) {
    throw Object.assign(new Error('No outgoing request with the given rkey, or already resolved'), { code: 'NotFound', status: 404 });
  }
  await assertMayWriteFor(callerDid); // #240: their device signs it, through prepareAction

  await writeRepoAs(callerDid, [{ action: 'delete', collection: REQUEST_COLLECTION, rkey }]);

  await query('DELETE FROM contact_requests WHERE from_did = $1 AND rkey = $2', [callerDid, rkey]);
}

// ── #71 block / unblock / listBlocks ────────────────────────────────────────

export async function blockContact(auth: AuthContext, subject: string): Promise<void> {
  const callerDid = auth.did!;
  if (!subject) throw Object.assign(new Error('Missing subject'), { code: 'InvalidRequest', status: 400 });
  if (subject === callerDid) throw Object.assign(new Error('Cannot block yourself'), { code: 'InvalidRequest', status: 400 });
  // The block is a record in the caller's repo (#240), refused before any
  // contact or request is removed. Under device signing the caller's device
  // signs everything blocking changes in their repo, as one commit, first.
  // The other side's records are removed best effort, which skips a repo
  // whose device signs it.
  await assertMayWriteFor(callerDid);

  const existingContact = await query<{ rkey: string; side: string }>(
    `SELECT rkey, 'caller' as side FROM contacts WHERE user_did = $1 AND contact_did = $2
     UNION ALL
     SELECT rkey, 'subject' as side FROM contacts WHERE user_did = $2 AND contact_did = $1`,
    [callerDid, subject],
  );
  const pendingReqs = await query<{ from_did: string; rkey: string }>(
    `SELECT from_did, rkey FROM contact_requests
      WHERE (from_did = $1 AND to_did = $2) OR (from_did = $2 AND to_did = $1)`,
    [callerDid, subject],
  );
  // Already blocked: the cleanup below runs again, and there is nothing to
  // add. Writing another block record each time left duplicates in the repo
  // that a single unblock did not remove.
  const alreadyBlocked = (await query(
    'SELECT 1 FROM contact_blocks WHERE blocker_did = $1 AND blocked_did = $2',
    [callerDid, subject],
  )).rows.length > 0;

  // The caller's own records: their contact record and request naming the
  // subject (those still in the repo), and the new block record.
  const ownDeletes = [
    ...existingContact.rows.filter((r) => r.side === 'caller').map((r) => ({ collection: CONTACT_COLLECTION, rkey: r.rkey })),
    ...pendingReqs.rows.filter((r) => r.from_did === callerDid).map((r) => ({ collection: REQUEST_COLLECTION, rkey: r.rkey })),
  ];
  const present = ownDeletes.length === 0 ? new Set<string>() : new Set((await query<{ key: string }>(
    `SELECT collection || '/' || rkey AS key FROM records_index
      WHERE community_did = $1 AND (collection || '/' || rkey) = ANY($2)`,
    [callerDid, ownDeletes.map((d) => `${d.collection}/${d.rkey}`)],
  )).rows.map((r) => r.key));
  const ownOps = [
    ...ownDeletes.filter((d) => present.has(`${d.collection}/${d.rkey}`)).map((d) => ({ action: 'delete' as const, ...d })),
    ...(alreadyBlocked ? [] : [{
      action: 'write' as const, collection: BLOCK_COLLECTION, rkey: RepoEngine.generateTid(),
      record: { subject, createdAt: new Date().toISOString() },
    }]),
  ];
  const written = await writeRepoAs(callerDid, ownOps);
  const blockRkey = alreadyBlocked ? null : written[written.length - 1].rkey;

  // The subject's side, best effort.
  for (const row of existingContact.rows) {
    if (row.side !== 'subject') continue;
    try {
      await writeRepoAs(subject, [{ action: 'delete', collection: CONTACT_COLLECTION, rkey: row.rkey }]);
    } catch { /* best effort */ }
  }
  for (const row of pendingReqs.rows) {
    if (row.from_did === callerDid) continue;
    try {
      await writeRepoAs(row.from_did, [{ action: 'delete', collection: REQUEST_COLLECTION, rkey: row.rkey }]);
    } catch { /* best effort */ }
  }

  await query(
    `DELETE FROM contacts WHERE (user_did = $1 AND contact_did = $2) OR (user_did = $2 AND contact_did = $1)`,
    [callerDid, subject],
  );
  await query(
    `DELETE FROM contact_requests
      WHERE (from_did = $1 AND to_did = $2) OR (from_did = $2 AND to_did = $1)`,
    [callerDid, subject],
  );

  if (blockRkey) {
    await query(
      `INSERT INTO contact_blocks (blocker_did, blocked_did, rkey)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [callerDid, subject, blockRkey],
    );
  }
}

export async function unblockContact(auth: AuthContext, subject: string): Promise<void> {
  const callerDid = auth.did!;

  const row = await query<{ rkey: string }>(
    'SELECT rkey FROM contact_blocks WHERE blocker_did = $1 AND blocked_did = $2',
    [callerDid, subject],
  );
  if (row.rows.length === 0) {
    throw Object.assign(new Error('The given DID is not blocked'), { code: 'NotFound', status: 404 });
  }
  await assertMayWriteFor(callerDid); // #240: their device signs it, through prepareAction

  await writeRepoAs(callerDid, [{ action: 'delete', collection: BLOCK_COLLECTION, rkey: row.rows[0].rkey }]);

  await query('DELETE FROM contact_blocks WHERE blocker_did = $1 AND blocked_did = $2', [callerDid, subject]);
}

export async function listBlocks(
  auth: AuthContext,
  limit: number,
  cursor?: string,
): Promise<{ blocks: unknown[]; cursor?: string }> {
  const callerDid = auth.did!;

  let sql = `SELECT cb.blocked_did, cb.rkey, cb.created_at, u.handle
             FROM contact_blocks cb
             LEFT JOIN users u ON u.did = cb.blocked_did
             WHERE cb.blocker_did = $1`;
  const params: (string | number)[] = [callerDid];
  let idx = 2;

  if (cursor) { sql += ` AND cb.rkey > $${idx++}`; params.push(cursor); }
  sql += ` ORDER BY cb.created_at ASC LIMIT $${idx}`;
  params.push(limit + 1);

  const result = await query<{ blocked_did: string; rkey: string; created_at: Date; handle: string | null }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].rkey;
  }

  return {
    blocks: rows.map(r => ({
      did: r.blocked_did,
      handle: fullHandle(r.handle) ?? r.blocked_did,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

// ── #72 mutual contacts / friend-of-friends ──────────────────────────────────

export async function listMutualContacts(
  auth: AuthContext,
  subject: string,
  limit: number,
  cursor?: string,
): Promise<{ contacts: unknown[]; cursor?: string }> {
  const callerDid = auth.did!;

  const isContact = await query(
    'SELECT 1 FROM contacts WHERE user_did = $1 AND contact_did = $2',
    [callerDid, subject],
  );
  if (isContact.rows.length === 0) {
    throw Object.assign(new Error('Subject is not an accepted contact of the caller'), { code: 'NotFound', status: 404 });
  }

  let sql = `SELECT c.contact_did, u.handle
             FROM contacts c
             LEFT JOIN users u ON u.did = c.contact_did
             WHERE c.user_did = $1
               AND c.contact_did != $2
               AND EXISTS (
                 SELECT 1 FROM contacts c2
                 WHERE c2.user_did = $2 AND c2.contact_did = c.contact_did
               )`;
  const params: (string | number)[] = [callerDid, subject];
  let idx = 3;

  if (cursor) { sql += ` AND c.contact_did > $${idx++}`; params.push(cursor); }
  sql += ` ORDER BY c.contact_did ASC LIMIT $${idx}`;
  params.push(limit + 1);

  const result = await query<{ contact_did: string; handle: string | null }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].contact_did;
  }

  return {
    contacts: rows.map(r => ({ did: r.contact_did, handle: fullHandle(r.handle) ?? r.contact_did })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

export async function listFriendOfFriends(
  auth: AuthContext,
  limit: number,
  cursor?: string,
): Promise<{ suggestions: unknown[]; cursor?: string }> {
  const callerDid = auth.did!;

  const innerSql = `
    SELECT fof.contact_did as did,
           u.handle,
           COUNT(*) as mutual_count
    FROM contacts my
    JOIN contacts fof ON fof.user_did = my.contact_did
    JOIN users u ON u.did = fof.contact_did
    WHERE my.user_did = $1
      AND fof.contact_did != $1
      AND u.fof_discovery = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM contacts direct
        WHERE direct.user_did = $1 AND direct.contact_did = fof.contact_did
      )
      AND NOT EXISTS (
        SELECT 1 FROM contact_blocks b
        WHERE (b.blocker_did = $1 AND b.blocked_did = fof.contact_did)
           OR (b.blocker_did = fof.contact_did AND b.blocked_did = $1)
      )
    GROUP BY fof.contact_did, u.handle`;

  const params: (string | number)[] = [callerDid];
  let idx = 2;

  let sql = `SELECT * FROM (${innerSql}) sub`;
  if (cursor) {
    // Cursor is "<mutual_count>:<did>", the last row of the previous page in
    // the (mutual_count DESC, did ASC) ordering. Paging on the count alone
    // skipped every remaining suggestion that shared the boundary's count.
    const sep = cursor.indexOf(':');
    const count = parseInt(sep === -1 ? cursor : cursor.slice(0, sep), 10) || 0;
    const afterDid = sep === -1 ? null : cursor.slice(sep + 1);
    if (afterDid) {
      sql += ` WHERE (mutual_count < $${idx}::bigint OR (mutual_count = $${idx}::bigint AND did > $${idx + 1}))`;
      params.push(count, afterDid);
      idx += 2;
    } else {
      // A bare count is the old cursor format; keep honouring it.
      sql += ` WHERE mutual_count < $${idx++}::bigint`;
      params.push(count);
    }
  }
  sql += ` ORDER BY mutual_count DESC, did ASC LIMIT $${idx}`;
  params.push(limit + 1);

  const result = await query<{ did: string; handle: string | null; mutual_count: string }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    const last = rows[rows.length - 1];
    nextCursor = `${last.mutual_count}:${last.did}`;
  }

  return {
    suggestions: rows.map(r => ({
      did: r.did,
      handle: fullHandle(r.handle) ?? r.did,
      mutualCount: parseInt(r.mutual_count, 10),
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}
