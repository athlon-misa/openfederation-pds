/**
 * E2E: tombstone() against the real local PLC directory (port 2582,
 * `npm run plc:dev`). The DID stops resolving and its audit log ends with
 * the tombstone; words that are not its rotation key are refused by PLC too.
 */
import { config } from '../../src/config.js';
import {
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  buildMoveOp, signPlcOp, tombstone, buildTombstoneOp, signTombstoneOp, cidForPlcOp,
} from '../../packages/openfederation-pseudonym/src/index.js';

const plcUrl = config.plc.directoryUrl;
let plc = false;

beforeAll(async () => {
  try {
    plc = (await fetch(`${plcUrl}/_health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch { plc = false; }
});

async function registerPseudonym(phrase: string): Promise<string> {
  const keys = derivePseudonymKeys(phrase);
  const genesis = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: keys.ownerDidKey, handle: `nd${Date.now()}.tombstone.example`,
    pdsEndpoint: 'https://pds-a.example', ownerDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(genesis);
  const res = await fetch(`${plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(genesis) });
  expect(res.status).toBe(200);
  const move = signPlcOp(buildMoveOp({ previous: genesis, signingDidKey: keys.ownerDidKey, pdsEndpoint: 'https://pds-b.example' }), keys.ownerPrivateKey);
  const moved = await fetch(`${plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(move) });
  expect(moved.status).toBe(200);
  return did;
}

describe('pseudonym tombstone on the local PLC', () => {
  it('ends a moved pseudonym DID with its own words', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const phrase = generatePseudonymPhrase();
    const did = await registerPseudonym(phrase);
    expect((await fetch(`${plcUrl}/${did}`)).status).toBe(200);

    const op = await tombstone({ plcUrl, did, phrase });

    expect((await fetch(`${plcUrl}/${did}`)).status).toBe(404);
    const audit = await (await fetch(`${plcUrl}/${did}/log/audit`)).json() as { operation: { type: string }; nullified: boolean }[];
    expect(audit.map((e) => e.operation.type)).toEqual(['plc_operation', 'plc_operation', 'plc_tombstone']);
    expect(audit[2].operation).toEqual(op);
    await expect(tombstone({ plcUrl, did, phrase })).rejects.toThrow(/AlreadyTombstoned/);
  });

  it('PLC refuses a tombstone signed with other words', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    const did = await registerPseudonym(generatePseudonymPhrase());
    const log = await (await fetch(`${plcUrl}/${did}/log`)).json() as object[];
    const stranger = derivePseudonymKeys(generatePseudonymPhrase());
    const forged = signTombstoneOp(buildTombstoneOp(log[log.length - 1]), stranger.ownerPrivateKey);
    expect(forged.prev).toBe(cidForPlcOp(log[log.length - 1]));
    const res = await fetch(`${plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forged) });
    expect(res.status).toBe(400);
    expect((await fetch(`${plcUrl}/${did}`)).status).toBe(200);
  });
});
