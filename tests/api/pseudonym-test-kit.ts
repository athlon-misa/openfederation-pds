import { xrpcGet, xrpcPost, xrpcAuthPost, createTestUser, uniqueHandle } from './helpers.js';
import { config } from '../../src/config.js';
import { setPlcClientForTests } from '../../src/identity/plc-client.js';
import { derivePseudonymKeys, generatePseudonymPhrase } from '../../packages/openfederation-pseudonym/src/keys.js';
import { buildPseudonymGenesisOp, signGenesisOp, didForSignedOp } from '../../packages/openfederation-pseudonym/src/plc.js';
import { importTokenPublicKey, blindTokens, finalizeTokens, type CreationToken } from '../../packages/openfederation-pseudonym/src/tokens.js';
import { currentEpoch } from '../../packages/openfederation-pseudonym/src/formats.js';

let wallet: CreationToken[] = [];

/** One fresh creation token, from a throwaway regular user's batch. */
export async function getToken(): Promise<CreationToken> {
  if (wallet.length === 0) {
    const user = await createTestUser(uniqueHandle('tokown'));
    const epoch = currentEpoch();
    const keys = (await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).body.keys;
    const pub = await importTokenPublicKey(keys.find((k: any) => k.epoch === epoch).publicKey);
    const pending = await blindTokens(pub, epoch, config.pseudonym.tokensPerEpoch);
    const res = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', user.accessJwt, { epoch, blindedMessages: pending.blinded });
    wallet = await finalizeTokens(pub, pending, res.body.blindSignatures);
  }
  return wallet.pop()!;
}

/** Genesis op for a new pseudonym, with a fake PLC log serving it. */
export async function preparePseudonym(phrase = generatePseudonymPhrase()) {
  const k = derivePseudonymKeys(phrase);
  const { body } = await xrpcPost('com.atproto.server.reserveSigningKey', {});
  const handle = `${uniqueHandle('pn')}${config.handleSuffix}`;
  const signed = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: k.ownerDidKey, signingDidKey: body.signingKey, handle,
    pdsEndpoint: config.pds.serviceUrl, ownerDid: 'did:plc:ownerplaceholder', commitmentSaltHex: k.commitmentSaltHex,
  }), k.ownerPrivateKey);
  const did = didForSignedOp(signed);
  const token = await getToken();
  setPlcClientForTests({
    async registerDidPlc() { throw new Error('unused'); },
    async resolveFromPlc() { return null; },
    async getPlcLog(d: string) { return d === did ? [signed as any] : null; },
  } as any);
  return { phrase, did, handle, token };
}
