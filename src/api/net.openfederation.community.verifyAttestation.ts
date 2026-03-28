import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { resolveDidToPds, fetchRemoteRecord } from '../federation/remote-verify.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

export default async function verifyAttestation(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const rkey = req.query.rkey as string;

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
    const communityHandle = communityResult.rows[0]?.handle;

    const result = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ATTESTATION_COLLECTION, rkey]
    );

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
        res.status(200).json({
          valid: false,
          communityDid,
          communityHandle: null,
          remote: true,
          error: 'Could not resolve community DID to a PDS',
        });
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

    res.status(200).json({
      valid: !expired,
      attestation: {
        uri: `at://${communityDid}/${ATTESTATION_COLLECTION}/${rkey}`,
        rkey,
        subjectDid: record?.subjectDid,
        subjectHandle: record?.subjectHandle,
        type: record?.type,
        claim: record?.claim,
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
