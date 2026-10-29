/**
 * The client side of moving a user account between two PDSes (#266), in
 * the standard AT Protocol order. The old PDS holds the rotation key, so it
 * signs the PLC update after an emailed code and the password; the client
 * checks the new PDS holds everything before asking for that signature.
 */
async function xrpc<T>(base: string, nsid: string, opts: { jwt?: string; body?: unknown; method?: 'GET' | 'POST'; query?: Record<string, string>; raw?: BodyInit; contentType?: string } = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const res = await fetch(`${base}/xrpc/${nsid}${qs}`, {
    method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
      ...(opts.raw !== undefined ? { 'Content-Type': opts.contentType ?? 'application/octet-stream' } : opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const json = await res.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${json.error ?? ''} ${json.message ?? ''}`.trim());
  return json;
}

export type CustodialMoveStep = 'open' | 'export' | 'import' | 'blobs' | 'check' | 'sign' | 'point' | 'activate' | 'retire';

export async function moveCustodialAccount(p: {
  oldPdsUrl: string; newPdsUrl: string; newServiceDid: string; plcUrl: string;
  did: string; handle: string; password: string; email: string; newHandle: string; inviteCode?: string;
  /** Reads the code the old PDS emailed. */
  readCode: () => Promise<string>;
  onStep?: (s: CustodialMoveStep) => void;
}): Promise<{ accessJwt: string; refreshJwt: string; rotationDeviceShare: string }> {
  const step = (s: CustodialMoveStep) => p.onStep?.(s);
  const old = await xrpc<{ accessJwt: string }>(p.oldPdsUrl, 'com.atproto.server.createSession', { body: { identifier: p.handle, password: p.password } });

  step('open');
  const { token } = await xrpc<{ token: string }>(p.oldPdsUrl, 'com.atproto.server.getServiceAuth',
    { jwt: old.accessJwt, query: { aud: p.newServiceDid, lxm: 'com.atproto.server.createAccount' } });
  const opened = await xrpc<{ accessJwt: string; refreshJwt: string; rotationDeviceShare: string }>(p.newPdsUrl, 'com.atproto.server.createAccount', {
    jwt: token, body: { did: p.did, handle: p.newHandle, email: p.email, password: p.password, ...(p.inviteCode ? { inviteCode: p.inviteCode } : {}) },
  });

  step('export');
  const car = await fetch(`${p.oldPdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(p.did)}`);
  if (!car.ok) throw new Error(`Old PDS did not export the repository (${car.status})`);
  step('import');
  await xrpc(p.newPdsUrl, 'com.atproto.repo.importRepo', { jwt: opened.accessJwt, raw: new Uint8Array(await car.arrayBuffer()), contentType: 'application/vnd.ipld.car' });

  step('blobs');
  for (;;) {
    const { blobs } = await xrpc<{ blobs: { cid: string }[] }>(p.newPdsUrl, 'com.atproto.repo.listMissingBlobs', { jwt: opened.accessJwt, query: { limit: '100' } });
    if (blobs.length === 0) break;
    for (const { cid } of blobs) {
      const blob = await fetch(`${p.oldPdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(p.did)}&cid=${cid}`);
      if (!blob.ok) throw new Error(`Old PDS did not serve blob ${cid}`);
      await xrpc(p.newPdsUrl, 'com.atproto.repo.uploadBlob', { jwt: opened.accessJwt, raw: new Uint8Array(await blob.arrayBuffer()), contentType: blob.headers.get('content-type') ?? 'application/octet-stream' });
    }
  }

  step('check');
  const status = await xrpc<{ indexedRecords: number; expectedBlobs: number; importedBlobs: number }>(p.newPdsUrl, 'com.atproto.server.checkAccountStatus', { jwt: opened.accessJwt });
  if (status.indexedRecords === 0 || status.importedBlobs !== status.expectedBlobs) throw new Error('The new PDS does not hold everything yet; not changing the DID');

  step('sign');
  const creds = await xrpc<{ rotationKeys: string[]; alsoKnownAs: string[]; verificationMethods: unknown; services: unknown }>(
    p.newPdsUrl, 'com.atproto.identity.getRecommendedDidCredentials', { jwt: opened.accessJwt });
  await xrpc(p.oldPdsUrl, 'com.atproto.identity.requestPlcOperationSignature', { jwt: old.accessJwt, body: {} });
  const code = await p.readCode();
  const { operation } = await xrpc<{ operation: unknown }>(p.oldPdsUrl, 'com.atproto.identity.signPlcOperation', {
    jwt: old.accessJwt, body: { token: code, password: p.password, ...creds },
  });

  step('point');
  await xrpc(p.oldPdsUrl, 'com.atproto.identity.submitPlcOperation', { jwt: old.accessJwt, body: { operation } });

  step('activate');
  await xrpc(p.newPdsUrl, 'com.atproto.server.activateAccount', { jwt: opened.accessJwt, body: {} });
  const session = await xrpc<{ accessJwt: string; refreshJwt: string }>(p.newPdsUrl, 'com.atproto.server.createSession', { body: { identifier: p.email, password: p.password } });

  step('retire');
  try {
    await xrpc(p.oldPdsUrl, 'com.atproto.server.deactivateAccount', { jwt: old.accessJwt, body: {} });
  } catch {
    // The move is complete either way.
  }
  return { ...session, rotationDeviceShare: opened.rotationDeviceShare };
}
