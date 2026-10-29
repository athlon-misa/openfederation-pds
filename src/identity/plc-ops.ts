/**
 * Building and signing PLC operations on the server (#266): the old PDS
 * signs an account's move with the rotation key it holds in custody. The
 * key is rebuilt from its Shamir shares for the signing call only and
 * wiped right after.
 */
import { getPlcLog } from './plc-client.js';
import { getShare } from '../vault/vault-store.js';
import { combineShares } from '../vault/shamir.js';
import { cidForPlcOp, signPlcOp, type PlcUpdateOp } from '../../packages/openfederation-pseudonym/src/plc.js';

export interface PlcOpOverrides {
  rotationKeys?: string[];
  alsoKnownAs?: string[];
  verificationMethods?: Record<string, string>;
  services?: PlcUpdateOp['services'];
}

const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

export class PlcOpError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** The DID's next operation: its current state with the given fields replaced. */
export async function buildNextOp(did: string, overrides: PlcOpOverrides): Promise<PlcUpdateOp> {
  const log = await getPlcLog(did);
  const last = log?.[log.length - 1] as (PlcUpdateOp & { sig: string }) | undefined;
  if (!last || last.type !== 'plc_operation') throw new PlcOpError('InvalidRequest', 'The DID has no current PLC operation');
  const op: PlcUpdateOp = {
    type: 'plc_operation',
    prev: cidForPlcOp(last),
    rotationKeys: overrides.rotationKeys ?? [...last.rotationKeys],
    verificationMethods: overrides.verificationMethods ?? { ...last.verificationMethods },
    alsoKnownAs: overrides.alsoKnownAs ?? [...last.alsoKnownAs],
    services: overrides.services ?? { ...last.services },
  };
  if (!Array.isArray(op.rotationKeys) || op.rotationKeys.length === 0 || !op.rotationKeys.every((k) => DID_KEY.test(k))) {
    throw new PlcOpError('InvalidRequest', 'rotationKeys must be a non-empty list of did:key values');
  }
  if (!Object.values(op.verificationMethods).every((k) => DID_KEY.test(k))) {
    throw new PlcOpError('InvalidRequest', 'verificationMethods must be did:key values');
  }
  if (typeof op.services?.atproto_pds?.endpoint !== 'string') {
    throw new PlcOpError('InvalidRequest', 'services.atproto_pds.endpoint is required');
  }
  return op;
}

/** True when this PDS holds the shares to rebuild the user's rotation key. */
export async function holdsRotationKey(did: string): Promise<boolean> {
  const [s2, s3] = await Promise.all([getShare(did, 2), getShare(did, 3)]);
  return !!s2 && !!s3;
}

/** Sign with the custodial rotation key; the key lives only for this call. */
export async function signWithCustodialKey(did: string, op: PlcUpdateOp): Promise<PlcUpdateOp & { sig: string }> {
  const [s2, s3] = await Promise.all([getShare(did, 2), getShare(did, 3)]);
  if (!s2 || !s3) throw new PlcOpError('NotCustodial', 'This PDS does not hold a rotation key for this account');
  const key = combineShares([s2, s3]);
  try {
    return signPlcOp(op, new Uint8Array(key));
  } finally {
    key.fill(0);
  }
}
