import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import type { AuthContext } from '../auth/types.js';
import { resolveDisplayFields, batchResolveOptionalDisplayFields } from '../community/display-projection.js';
import { createNotification } from '../notification/index.js';

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

  const engine = new RepoEngine(callerDid);
  const keypair = await getKeypairForDid(callerDid);
  const rkey = RepoEngine.generateTid();
  const issuedAt = new Date().toISOString();

  const record = {
    subject,
    createdAt: issuedAt,
    ...(note ? { note } : {}),
  };

  const result = await engine.putRecord(keypair, REQUEST_COLLECTION, rkey, record);

  // Get recipient's handle for the index
  const recipientRow = await query<{ handle: string }>(
    'SELECT handle FROM users WHERE did = $1',
    [subject],
  );
  const toHandle = recipientRow.rows[0]?.handle ?? subject;

  await query(
    `INSERT INTO contact_requests (from_did, to_did, rkey, note, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [callerDid, subject, rkey, note ?? null, issuedAt],
  );

  // Notify the recipient (#70)
  await createNotification(subject, 'contact-request', {
    fromDid: callerDid,
    fromHandle: auth.handle ?? callerDid,
    rkey,
    ...(note ? { note } : {}),
  }).catch(() => { /* non-critical */ });

  return { rkey, uri: result.uri, cid: result.cid };
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

  const reqRow = await query<{ from_did: string; note: string | null; created_at: Date }>(
    'SELECT from_did, note, created_at FROM contact_requests WHERE to_did = $1 AND rkey = $2',
    [callerDid, rkey],
  );
  if (reqRow.rows.length === 0) {
    throw Object.assign(new Error('No incoming request with the given rkey'), { code: 'NotFound', status: 404 });
  }
  const { from_did: fromDid } = reqRow.rows[0];

  if (action === 'accept') {
    const acceptedAt = new Date().toISOString();

    // Create contact record on caller's repo (pointing at requester)
    const callerEngine = new RepoEngine(callerDid);
    const callerKeypair = await getKeypairForDid(callerDid);
    const callerRkey = RepoEngine.generateTid();
    await callerEngine.putRecord(callerKeypair, CONTACT_COLLECTION, callerRkey, {
      subject: fromDid,
      acceptedAt,
    });

    // Create contact record on requester's repo (pointing at caller)
    const fromEngine = new RepoEngine(fromDid);
    const fromKeypair = await getKeypairForDid(fromDid);
    const fromContactRkey = RepoEngine.generateTid();
    await fromEngine.putRecord(fromKeypair, CONTACT_COLLECTION, fromContactRkey, {
      subject: callerDid,
      acceptedAt,
    });

    // Delete the request record from requester's repo
    await fromEngine.deleteRecord(fromKeypair, REQUEST_COLLECTION, rkey);

    // Insert both contact rows into the index
    await query(
      `INSERT INTO contacts (user_did, contact_did, rkey, accepted_at)
       VALUES ($1, $2, $3, $4), ($2, $1, $5, $4)
       ON CONFLICT DO NOTHING`,
      [callerDid, fromDid, callerRkey, acceptedAt, fromContactRkey],
    );
  } else {
    // Reject — just delete the request record from requester's repo
    const fromEngine = new RepoEngine(fromDid);
    const fromKeypair = await getKeypairForDid(fromDid);
    await fromEngine.deleteRecord(fromKeypair, REQUEST_COLLECTION, rkey);
  }

  // Remove from index
  await query(
    'DELETE FROM contact_requests WHERE to_did = $1 AND rkey = $2',
    [callerDid, rkey],
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

  const subjectRow = await query<{ rkey: string }>(
    'SELECT rkey FROM contacts WHERE user_did = $1 AND contact_did = $2',
    [subject, callerDid],
  );

  // Delete caller's contact record from their repo
  const callerEngine = new RepoEngine(callerDid);
  const callerKeypair = await getKeypairForDid(callerDid);
  await callerEngine.deleteRecord(callerKeypair, CONTACT_COLLECTION, callerContactRkey);

  // Cooperatively remove from counterpart's repo if record exists
  if (subjectRow.rows.length > 0) {
    try {
      const subjectEngine = new RepoEngine(subject);
      const subjectKeypair = await getKeypairForDid(subject);
      await subjectEngine.deleteRecord(subjectKeypair, CONTACT_COLLECTION, subjectRow.rows[0].rkey);
    } catch {
      // Counterpart repo may be on a remote PDS — best effort
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
      handle: row.handle ?? row.contact_did,
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
      fromHandle: row.handle ?? row.from_did,
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
      toHandle: row.handle ?? row.to_did,
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

  const engine = new RepoEngine(callerDid);
  const keypair = await getKeypairForDid(callerDid);
  await engine.deleteRecord(keypair, REQUEST_COLLECTION, rkey);

  await query('DELETE FROM contact_requests WHERE from_did = $1 AND rkey = $2', [callerDid, rkey]);
}

// ── #71 block / unblock / listBlocks ────────────────────────────────────────

export async function blockContact(auth: AuthContext, subject: string): Promise<void> {
  const callerDid = auth.did!;
  if (!subject) throw Object.assign(new Error('Missing subject'), { code: 'InvalidRequest', status: 400 });
  if (subject === callerDid) throw Object.assign(new Error('Cannot block yourself'), { code: 'InvalidRequest', status: 400 });

  // Remove any existing contact in either direction
  const existingContact = await query<{ rkey: string; side: string }>(
    `SELECT rkey, 'caller' as side FROM contacts WHERE user_did = $1 AND contact_did = $2
     UNION ALL
     SELECT rkey, 'subject' as side FROM contacts WHERE user_did = $2 AND contact_did = $1`,
    [callerDid, subject],
  );
  for (const row of existingContact.rows) {
    try {
      const ownerDid = row.side === 'caller' ? callerDid : subject;
      const eng = new RepoEngine(ownerDid);
      const kp = await getKeypairForDid(ownerDid);
      await eng.deleteRecord(kp, CONTACT_COLLECTION, row.rkey);
    } catch { /* best effort */ }
  }
  await query(
    `DELETE FROM contacts WHERE (user_did = $1 AND contact_did = $2) OR (user_did = $2 AND contact_did = $1)`,
    [callerDid, subject],
  );

  // Remove pending requests in either direction
  const pendingReqs = await query<{ from_did: string; rkey: string }>(
    `SELECT from_did, rkey FROM contact_requests
      WHERE (from_did = $1 AND to_did = $2) OR (from_did = $2 AND to_did = $1)`,
    [callerDid, subject],
  );
  for (const row of pendingReqs.rows) {
    try {
      const eng = new RepoEngine(row.from_did);
      const kp = await getKeypairForDid(row.from_did);
      await eng.deleteRecord(kp, REQUEST_COLLECTION, row.rkey);
    } catch { /* best effort */ }
  }
  await query(
    `DELETE FROM contact_requests
      WHERE (from_did = $1 AND to_did = $2) OR (from_did = $2 AND to_did = $1)`,
    [callerDid, subject],
  );

  // Create block record on caller's repo
  const engine = new RepoEngine(callerDid);
  const keypair = await getKeypairForDid(callerDid);
  const blockRkey = RepoEngine.generateTid();
  await engine.putRecord(keypair, BLOCK_COLLECTION, blockRkey, {
    subject,
    createdAt: new Date().toISOString(),
  });

  await query(
    `INSERT INTO contact_blocks (blocker_did, blocked_did, rkey)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [callerDid, subject, blockRkey],
  );
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

  const engine = new RepoEngine(callerDid);
  const keypair = await getKeypairForDid(callerDid);
  await engine.deleteRecord(keypair, BLOCK_COLLECTION, row.rows[0].rkey);

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
      handle: r.handle ?? r.blocked_did,
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
    contacts: rows.map(r => ({ did: r.contact_did, handle: r.handle ?? r.contact_did })),
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
    sql += ` WHERE mutual_count < $${idx++}::bigint`;
    params.push(parseInt(cursor, 10) || 0);
  }
  sql += ` ORDER BY mutual_count DESC, did ASC LIMIT $${idx}`;
  params.push(limit + 1);

  const result = await query<{ did: string; handle: string | null; mutual_count: string }>(sql, params);

  let rows = result.rows;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = rows[rows.length - 1].mutual_count;
  }

  return {
    suggestions: rows.map(r => ({
      did: r.did,
      handle: r.handle ?? r.did,
      mutualCount: parseInt(r.mutual_count, 10),
    })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}
