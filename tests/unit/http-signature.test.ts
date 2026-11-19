import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { digestHeader, parseSignatureHeader, signedPostHeaders, verifySignedPost } from '../../src/activitypub/http-signature.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const URL_ = 'https://pds.example/ap/actor/did:plc:abc/inbox';
const BODY = JSON.stringify({ type: 'Follow' });

function signed(body = BODY, date?: Date) {
  const h = signedPostHeaders({ url: URL_, body, keyId: 'https://m.example/users/a#main-key', privateKeyPem: privateKey, date });
  const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers, signature: parseSignatureHeader(headers.signature)! };
}

describe('HTTP signatures', () => {
  it('a signed POST verifies, over the path exactly as sent', () => {
    const { headers, signature } = signed();
    expect(signature).toMatchObject({ keyId: 'https://m.example/users/a#main-key', algorithm: 'rsa-sha256', headers: ['(request-target)', 'host', 'date', 'digest'] });
    expect(verifySignedPost({ signature, path: '/ap/actor/did:plc:abc/inbox', headers, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBeNull();
    expect(verifySignedPost({ signature, path: '/ap/actor/did:plc:other/inbox', headers, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBe('bad_signature');
  });

  it('refuses a changed body, a stale date, missing headers and other algorithms', () => {
    const { headers, signature } = signed();
    const path = '/ap/actor/did:plc:abc/inbox';
    expect(verifySignedPost({ signature, path, headers, body: Buffer.from('{}'), publicKeyPem: publicKey })).toBe('digest_mismatch');
    const old = signed(BODY, new Date(Date.now() - 2 * 60 * 60 * 1000));
    expect(verifySignedPost({ ...old, path, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBe('stale_date');
    expect(verifySignedPost({ signature: { ...signature, headers: ['date'] }, path, headers, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBe('headers_not_covered');
    expect(verifySignedPost({ signature: { ...signature, algorithm: 'ed25519' }, path, headers, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBe('unsupported_algorithm');
    expect(verifySignedPost({ signature: { ...signature, algorithm: 'hs2019' }, path, headers, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBeNull();
  });

  it('accepts the digest with any letter case or among others', () => {
    const { headers, signature } = signed();
    const path = '/ap/actor/did:plc:abc/inbox';
    const value = digestHeader(BODY).slice('SHA-256='.length);
    // The digest header is itself signed, so a re-cased one fails the signature, not the digest check.
    expect(verifySignedPost({ signature, path, headers: { ...headers, digest: `sha-256=${value}` }, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBe('bad_signature');
    expect(verifySignedPost({ signature, path, headers: { ...headers, digest: 'SHA-256=AAAA' }, body: Buffer.from(BODY), publicKeyPem: publicKey })).toBe('digest_mismatch');
  });

  it('parses Signature headers defensively', () => {
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader('keyId=unquoted,signature="x"')).toBeNull();
    expect(parseSignatureHeader('keyId="k"')).toBeNull();
    expect(parseSignatureHeader('x'.repeat(5000))).toBeNull();
    expect(parseSignatureHeader('keyId="k", signature="s"')).toMatchObject({ keyId: 'k', headers: ['date'] });
  });
});
