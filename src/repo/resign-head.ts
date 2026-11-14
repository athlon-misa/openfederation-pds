import { RepoEngine } from './repo-engine.js';
import { getKeypairForDid } from './keypair-utils.js';
import { isDeviceSigningOn } from './device-signing-state.js';

/**
 * When an account or community is switched on here after a move (#422),
 * sign its repo head with this PDS's key, so the repo verifies against the
 * key the DID now names. Without it the head stays signed by the old home's
 * key until the first write here, and moving straight back fails: the old
 * home's import checks the head against the DID's current key (the #265
 * rollback guard) and refuses it as InvalidSignature.
 *
 * A no-op when the head is already ours (a plain reactivation) or there is
 * no repo (the bootstrap admin). Skipped for accounts with device signing on
 * (#240): the device holds the repo key and the server never signs for them,
 * so their repo verifies only once the device signs a commit of its own.
 *
 * Returns whether a new commit was made.
 */
export async function resignHeadForThisPds(did: string): Promise<boolean> {
  const engine = new RepoEngine(did);
  if (!(await engine.hasRepo()) || (await isDeviceSigningOn(did))) return false;
  return (await engine.resignHead(await getKeypairForDid(did))) !== null;
}
