import { Response } from 'express';
import { Secp256k1Keypair } from '@atproto/crypto';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { encryptKeyBytes } from '../auth/encryption.js';
import { heldRotationDidKey, planChange, plcHistory, possessionText } from '../identity/custody-change.js';
import { authorize, fail, inputsOf } from '../identity/custody-change-endpoint.js';

/** net.openfederation.identity.prepareCustodyChange (ADR-003, decision 5). */
export default async function prepareCustodyChange(req: AuthRequest, res: Response): Promise<void> {
  try {
    const auth = await authorize(req, res);
    if (!auth) return;
    const { account, target } = auth;
    const history = await plcHistory(account.did);
    const held = await heldRotationDidKey(account.did);
    const inputs = inputsOf(req.body);
    // Towards the PDS without a key of its own: make one now, held until finalize.
    if (account.mode !== 'custodial' && target !== 'self' && !held) {
      const keypair = await Secp256k1Keypair.create({ exportable: true });
      const bytes = Buffer.from(await keypair.export());
      await query('INSERT INTO reserved_rotation_keys (rotation_key, key_bytes) VALUES ($1, $2)',
        [keypair.did(), await encryptKeyBytes(bytes, 'identity.recovery-key')]);
      bytes.fill(0);
      inputs.pdsRotationDidKey = keypair.did();
    }
    const plan = planChange(history[history.length - 1], account.mode, target, held, inputs);
    res.status(200).json({
      operation: plan.op,
      operationCid: plan.cid,
      signer: plan.signer,
      ...(plan.newPdsKey ? { pdsRotationDidKey: plan.newPdsKey } : {}),
      ...(plan.signer === 'pds' ? { possessionText: possessionText(account.did, plan.cid) } : {}),
    });
  } catch (error) {
    fail(res, error, 'prepare the custody change');
  }
}
