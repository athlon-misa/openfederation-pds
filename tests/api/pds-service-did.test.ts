import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/server/index.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import { decryptKeyBytes } from '../../src/auth/encryption.js';

// Validates the PDS's own service DID document is served at
// /.well-known/did.json when no did:web community is registered at the
// configured PDS hostname (closes #44).

describe('/.well-known/did.json — PDS service DID', () => {
  it('returns a valid did:web service document', async () => {
    // Precondition: no community registered at did:web:{pds.hostname}.
    // (The community path is a separate test.)
    const hostname = config.pds.hostname;
    await query(`DELETE FROM communities WHERE did = $1`, [`did:web:${hostname}`]);

    const res = await request(app).get('/.well-known/did.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/did\+json/);

    const doc = res.body;
    expect(doc.id).toBe(`did:web:${hostname}`);
    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(doc['@context']).toContain('https://w3id.org/security/multikey/v1');
    expect(doc.alsoKnownAs).toEqual([`https://${hostname}`]);

    // Service endpoint points at the configured PDS URL.
    expect(Array.isArray(doc.service)).toBe(true);
    const atprotoService = doc.service.find(
      (s: any) => s.type === 'AtprotoPersonalDataServer'
    );
    expect(atprotoService).toBeDefined();
    expect(atprotoService.serviceEndpoint).toBe(config.pds.serviceUrl);

    // Verification method is a Multikey controlled by this DID.
    expect(Array.isArray(doc.verificationMethod)).toBe(true);
    const atprotoVm = doc.verificationMethod.find(
      (vm: any) => vm.id === `${doc.id}#atproto`
    );
    expect(atprotoVm).toBeDefined();
    expect(atprotoVm.type).toBe('Multikey');
    expect(atprotoVm.controller).toBe(doc.id);
    expect(atprotoVm.publicKeyMultibase).toMatch(/^z/); // base58btc multibase prefix
    expect(doc.assertionMethod).toContain(`${doc.id}#atproto`);
  });

  it('persists the service key between requests (same Multikey)', async () => {
    const a = (await request(app).get('/.well-known/did.json')).body;
    const b = (await request(app).get('/.well-known/did.json')).body;
    expect(a.verificationMethod[0].publicKeyMultibase)
      .toBe(b.verificationMethod[0].publicKeyMultibase);
  });

  it('stores a decryptable private key matching the advertised public key', async () => {
    const hostname = config.pds.hostname;
    // Trigger key generation if this is the first test to hit the route.
    await request(app).get('/.well-known/did.json');

    const row = await query<{ public_key_multibase: string; private_key_encrypted: Buffer }>(
      `SELECT public_key_multibase, private_key_encrypted FROM pds_service_keys WHERE hostname = $1`,
      [hostname]
    );
    expect(row.rows.length).toBe(1);

    const decrypted = await decryptKeyBytes(row.rows[0].private_key_encrypted);
    const kp = await Secp256k1Keypair.import(decrypted, { exportable: false });
    const { toMultibaseMultikeySecp256k1 } = await import('../../src/identity/manager.js');
    expect(toMultibaseMultikeySecp256k1(kp.publicKeyBytes())).toBe(
      row.rows[0].public_key_multibase
    );
  });
});
