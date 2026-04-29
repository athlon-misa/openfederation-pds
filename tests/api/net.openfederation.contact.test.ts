/**
 * Issue #67 — contact graph XRPC integration tests (RED first)
 *
 * Covers the full lifecycle:
 *  sendRequest → listIncoming/listOutgoing → respondToRequest →
 *  list → removeContact
 *
 * All tests require PLC directory; they skip gracefully when PLC is down.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet,
  xrpcAuthGet,
  xrpcAuthPost,
  createTestUser,
  uniqueHandle,
  isPLCAvailable,
} from './helpers.js';

describe('net.openfederation.contact (issue #67)', () => {
  let plcAvailable: boolean;
  let alice: { accessJwt: string; did: string; handle: string };
  let bob: { accessJwt: string; did: string; handle: string };
  let charlie: { accessJwt: string; did: string; handle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    alice = await createTestUser(uniqueHandle('alice'));
    bob = await createTestUser(uniqueHandle('bob'));
    charlie = await createTestUser(uniqueHandle('charlie'));
  });

  // ── Auth guard ───────────────────────────────────────────────────────────

  it('sendRequest: requires auth', async () => {
    const res = await xrpcAuthPost('net.openfederation.contact.sendRequest', '', {
      subject: 'did:plc:abc',
    });
    expect(res.status).toBe(401);
  });

  // ── sendRequest ──────────────────────────────────────────────────────────

  it('sendRequest: alice sends a request to bob', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, {
      subject: bob.did,
      note: 'Hey Bob!',
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.rkey).toBe('string');
    expect(typeof res.body.uri).toBe('string');
  });

  it('sendRequest: duplicate request returns 409', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, {
      subject: bob.did,
    });
    expect(res.status).toBe(409);
  });

  it('sendRequest: cannot send to yourself', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, {
      subject: alice.did,
    });
    expect(res.status).toBe(400);
  });

  // ── listIncomingRequests ─────────────────────────────────────────────────

  it('listIncomingRequests: bob sees alice\'s request', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthGet(
      'net.openfederation.contact.listIncomingRequests',
      bob.accessJwt,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requests)).toBe(true);
    const req = res.body.requests.find((r: any) => r.fromDid === alice.did);
    expect(req).toBeDefined();
    expect(req.note).toBe('Hey Bob!');
    expect(typeof req.rkey).toBe('string');
  });

  // ── listOutgoingRequests ─────────────────────────────────────────────────

  it('listOutgoingRequests: alice sees her pending request', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthGet(
      'net.openfederation.contact.listOutgoingRequests',
      alice.accessJwt,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requests)).toBe(true);
    const req = res.body.requests.find((r: any) => r.toDid === bob.did);
    expect(req).toBeDefined();
  });

  // ── respondToRequest: reject ─────────────────────────────────────────────

  it('respondToRequest reject: charlie can reject alice\'s request', async () => {
    if (!plcAvailable) return;

    // Alice sends to charlie first
    await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, {
      subject: charlie.did,
    });

    const incomingRes = await xrpcAuthGet(
      'net.openfederation.contact.listIncomingRequests',
      charlie.accessJwt,
    );
    const req = incomingRes.body.requests.find((r: any) => r.fromDid === alice.did);
    expect(req).toBeDefined();

    const rejectRes = await xrpcAuthPost(
      'net.openfederation.contact.respondToRequest',
      charlie.accessJwt,
      { rkey: req.rkey, action: 'reject' },
    );
    expect(rejectRes.status).toBe(200);

    // Request should be gone
    const afterRes = await xrpcAuthGet(
      'net.openfederation.contact.listIncomingRequests',
      charlie.accessJwt,
    );
    const stillThere = afterRes.body.requests.find((r: any) => r.fromDid === alice.did);
    expect(stillThere).toBeUndefined();
  });

  // ── respondToRequest: accept ─────────────────────────────────────────────

  it('respondToRequest accept: bob accepts alice\'s request → both become contacts', async () => {
    if (!plcAvailable) return;

    const incomingRes = await xrpcAuthGet(
      'net.openfederation.contact.listIncomingRequests',
      bob.accessJwt,
    );
    const req = incomingRes.body.requests.find((r: any) => r.fromDid === alice.did);
    expect(req).toBeDefined();

    const acceptRes = await xrpcAuthPost(
      'net.openfederation.contact.respondToRequest',
      bob.accessJwt,
      { rkey: req.rkey, action: 'accept' },
    );
    expect(acceptRes.status).toBe(200);

    // Request should be gone
    const afterIncoming = await xrpcAuthGet(
      'net.openfederation.contact.listIncomingRequests',
      bob.accessJwt,
    );
    const stillPending = afterIncoming.body.requests.find((r: any) => r.fromDid === alice.did);
    expect(stillPending).toBeUndefined();
  });

  it('sendRequest: 409 when already contacts', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.contact.sendRequest', alice.accessJwt, {
      subject: bob.did,
    });
    expect(res.status).toBe(409);
  });

  // ── list ─────────────────────────────────────────────────────────────────

  it('list: alice sees bob in her contacts', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthGet('net.openfederation.contact.list', alice.accessJwt);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.contacts)).toBe(true);

    const bobContact = res.body.contacts.find((c: any) => c.did === bob.did);
    expect(bobContact).toBeDefined();
    expect(typeof bobContact.handle).toBe('string');
    expect(typeof bobContact.acceptedAt).toBe('string');
  });

  it('list: bob sees alice in his contacts', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthGet('net.openfederation.contact.list', bob.accessJwt);
    expect(res.status).toBe(200);

    const aliceContact = res.body.contacts.find((c: any) => c.did === alice.did);
    expect(aliceContact).toBeDefined();
  });

  // ── removeContact ────────────────────────────────────────────────────────

  it('removeContact: alice removes bob → both sides gone', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.contact.removeContact', alice.accessJwt, {
      subject: bob.did,
    });
    expect(res.status).toBe(200);

    // Alice no longer sees bob
    const aliceList = await xrpcAuthGet('net.openfederation.contact.list', alice.accessJwt);
    const bobContact = aliceList.body.contacts.find((c: any) => c.did === bob.did);
    expect(bobContact).toBeUndefined();

    // Bob no longer sees alice
    const bobList = await xrpcAuthGet('net.openfederation.contact.list', bob.accessJwt);
    const aliceContact = bobList.body.contacts.find((c: any) => c.did === alice.did);
    expect(aliceContact).toBeUndefined();
  });

  it('removeContact: 404 when not a contact', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.contact.removeContact', alice.accessJwt, {
      subject: charlie.did,
    });
    expect(res.status).toBe(404);
  });
});
