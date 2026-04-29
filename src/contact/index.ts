import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import type { AuthContext } from '../auth/types.js';
import { resolveDisplayFields } from '../community/display-projection.js';

const REQUEST_COLLECTION = 'net.openfederation.contact.request';
const CONTACT_COLLECTION = 'net.openfederation.contact.contact';

export async function sendContactRequest(
  auth: AuthContext,
  subject: string,
  note?: string,
): Promise<{ rkey: string; uri: string; cid: string }> {
  const callerDid = auth.did;

  if (!callerDid) throw Object.assign(new Error('No DID on caller'), { code: 'InvalidRequest', status: 400 });
  if (!subject || !subject.startsWith('did:')) throw Object.assign(new Error('Invalid subject DID'), { code: 'InvalidRequest', status: 400 });
  if (subject === callerDid) throw Object.assign(new Error('Cannot send a contact request to yourself'), { code: 'InvalidRequest', status: 400 });

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

  const contacts = rows.map(row => ({
    did: row.contact_did,
    handle: row.handle ?? row.contact_did,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    ...(Array.isArray(row.tags) && row.tags.length > 0 ? { tags: row.tags } : {}),
  }));

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

  const requests = rows.map(row => ({
    rkey: row.rkey,
    fromDid: row.from_did,
    fromHandle: row.handle ?? row.from_did,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.note ? { note: row.note } : {}),
  }));

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

  const requests = rows.map(row => ({
    rkey: row.rkey,
    toDid: row.to_did,
    toHandle: row.handle ?? row.to_did,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.note ? { note: row.note } : {}),
  }));

  return {
    requests,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}
