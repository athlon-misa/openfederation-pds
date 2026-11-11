import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRepoReadable } from '../auth/guards.js';
import { query } from '../db/client.js';
import { resolveFromPlc } from '../identity/plc-client.js';
import { didKeyFromMultibase } from '../identity/pseudonym/verify.js';
import { verifyOwnerSignedRecord } from '../identity/owner-record.js';

/**
 * net.openfederation.identity.verifyRecord (ADR-003, decision 11)
 *
 * Is this record person-signed? For records hosted here: `ownerSig` must
 * match the record's content and verify with the `openfederation_owner` key
 * in the author's DID document. For apps that don't resolve DIDs themselves.
 * Same readability rules as reading the record.
 */
export default async function verifyRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    const uri = typeof req.query.uri === 'string' ? req.query.uri : '';
    const m = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([A-Za-z0-9._:~-]+)$/.exec(uri);
    if (!m) {
      res.status(400).json({ error: 'InvalidRequest', message: 'uri must be at://<did>/<collection>/<rkey>' });
      return;
    }
    const [, did, collection, rkey] = m;
    const notFound = () => res.status(404).json({ error: 'RecordNotFound', message: 'No such record here' });
    if (!(await requireRepoReadable(req, res, did, notFound))) return;
    const row = (await query<{ record: Record<string, unknown>; cid: string }>(
      'SELECT record, cid FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3', [did, collection, rkey])).rows[0];
    if (!row) { notFound(); return; }

    if (!row.record.ownerSig) {
      res.status(200).json({ uri, cid: row.cid, personSigned: false, reason: 'NotSigned' });
      return;
    }
    let ownerKey: string | null = null;
    if (did.startsWith('did:plc:')) {
      const doc = await resolveFromPlc(did) as { verificationMethod?: { id: string; publicKeyMultibase?: string }[] } | null;
      const vm = doc?.verificationMethod?.find((v) => v.id.endsWith('#openfederation_owner'));
      ownerKey = vm?.publicKeyMultibase ? didKeyFromMultibase(vm.publicKeyMultibase) : null;
    }
    if (!ownerKey) {
      res.status(200).json({ uri, cid: row.cid, personSigned: false, reason: 'NoOwnerKey' });
      return;
    }
    const verdict = verifyOwnerSignedRecord(row.record, { did, collection, ownerDidKey: ownerKey });
    res.status(200).json({ uri, cid: row.cid, personSigned: verdict.ok, ownerKey, ...(verdict.ok ? {} : { reason: verdict.reason }) });
  } catch (error) {
    console.error('Error in identity.verifyRecord:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify the record' });
  }
}
