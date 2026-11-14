import { Response } from 'express';
import { verifyAccess } from '../attestation/verify-access.js';
import { filterGrantedFields } from '../attestation/lifecycle.js';
import { getCommunityAccess } from '../community/visibility.js';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { fullHandle } from '../auth/utils.js';
import { resolveDidToPds, fetchRemoteRecord } from '../federation/remote-verify.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

export default async function verifyAttestation(req: AuthRequest, res: Response): Promise<void> {
  try {
    // Strings only: a repeated parameter arrives as an array.
    const communityDid = typeof req.query.communityDid === 'string' ? req.query.communityDid : '';
    const rkey = typeof req.query.rkey === 'string' ? req.query.rkey : '';

    if (!communityDid || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'communityDid and rkey parameters are required',
      });
      return;
    }

    const communityResult = await query<{ handle: string }>(
      'SELECT handle FROM communities WHERE did = $1',
      [communityDid]
    );
    const communityHandle = fullHandle(communityResult.rows[0]?.handle);

    // For a community hosted here: a private community, or a private
    // attestation, is verifiable only by those mayVerifyAttestation names
    // (members, the subject, viewing-grant holders, admins). Anyone else gets
    // the answer for something that does not exist: NotFound for a private
    // community, `valid: false` for an attestation in a public one.
    const isLocalCommunity = communityResult.rows.length > 0;
    const verify = isLocalCommunity ? await verifyAccess(req.auth, communityDid, rkey) : { allowed: true };
    const allowed = verify.allowed;
    if (isLocalCommunity) {
      const access = await getCommunityAccess({ communityDid, caller: req.auth });
      if (access.visibility === 'private' && !allowed) {
        res.status(404).json({ error: 'NotFound', message: 'Community not found' });
        return;
      }
      if (access.status === 'takendown' && !access.isAdmin) {
        res.status(410).json({ error: 'CommunityTakenDown', message: 'This community has been taken down.' });
        return;
      }
    }

    const result = allowed ? await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ATTESTATION_COLLECTION, rkey]
    ) : { rows: [] as Array<{ record: any }> };

    if (result.rows.length === 0) {
      const isLocal = communityResult.rows.length > 0;

      if (isLocal) {
        res.status(200).json({
          valid: false,
          communityDid,
          communityHandle: communityHandle || null,
        });
        return;
      }

      const pdsUrl = await resolveDidToPds(communityDid);
      if (!pdsUrl) {
        // Same answer as a private community the caller cannot see.
        res.status(404).json({ error: 'NotFound', message: 'Community not found' });
        return;
      }

      const remoteRecord = await fetchRemoteRecord(
        pdsUrl, communityDid, ATTESTATION_COLLECTION, rkey
      );

      if (!remoteRecord || !remoteRecord.value) {
        res.status(200).json({
          valid: false,
          communityDid,
          communityHandle: null,
          remote: true,
          pdsUrl,
        });
        return;
      }

      const remoteData = remoteRecord.value;
      const remoteExpired = remoteData?.expiresAt ? new Date(remoteData.expiresAt) < new Date() : false;

      res.status(200).json({
        valid: !remoteExpired,
        remote: true,
        pdsUrl,
        attestation: {
          uri: remoteRecord.uri,
          rkey,
          subjectDid: remoteData?.subjectDid,
          subjectHandle: remoteData?.subjectHandle,
          type: remoteData?.type,
          claim: remoteData?.claim,
          issuedAt: remoteData?.issuedAt,
          expiresAt: remoteData?.expiresAt,
        },
        communityDid,
        communityHandle: null,
        expired: remoteExpired,
      });
      return;
    }

    const record = result.rows[0].record;
    const expired = record?.expiresAt ? new Date(record.expiresAt) < new Date() : false;
    // Someone who may look only through viewing grants sees only the granted fields.
    const claim = 'grantedFields' in verify && verify.grantedFields
      ? filterGrantedFields((record?.claim ?? {}) as Record<string, unknown>, verify.grantedFields)
      : record?.claim;

    res.status(200).json({
      valid: !expired,
      attestation: {
        uri: `at://${communityDid}/${ATTESTATION_COLLECTION}/${rkey}`,
        rkey,
        subjectDid: record?.subjectDid,
        subjectHandle: record?.subjectHandle,
        type: record?.type,
        claim,
        issuedAt: record?.issuedAt,
        expiresAt: record?.expiresAt,
      },
      communityDid,
      communityHandle: communityHandle || null,
      expired,
    });
  } catch (error) {
    console.error('Error in verifyAttestation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify attestation' });
  }
}
