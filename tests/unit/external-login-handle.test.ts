import { describe, expect, it } from 'vitest';
import { chooseExternalHandle, placeholderHandle } from '../../src/oauth/external-handle.js';

const did = 'did:plc:abcdefghijklmnopqrstuvwx';
const deps = (over: Partial<Parameters<typeof chooseExternalHandle>[2]> = {}) => ({
  localSuffix: '.openfederation.net',
  resolveHandle: async (h: string) => (h === 'alice.example.com' ? did : null),
  isTaken: async () => false,
  ...over,
});

describe('handle for an account signing in from another PDS', () => {
  it('accepts a handle that resolves back to the same DID', async () => {
    expect(await chooseExternalHandle(did, 'alice.example.com', deps())).toBe('alice.example.com');
  });

  it('does not take a bare name such as "admin" from the DID document', async () => {
    expect(await chooseExternalHandle(did, 'admin', deps())).toBe(placeholderHandle(did));
  });

  it('does not take a handle under this PDS\'s own suffix', async () => {
    const d = deps({ resolveHandle: async () => did });
    expect(await chooseExternalHandle(did, 'admin.openfederation.net', d)).toBe(placeholderHandle(did));
  });

  it('does not take a handle that does not resolve back to the DID', async () => {
    expect(await chooseExternalHandle(did, 'bob.example.com', deps())).toBe(placeholderHandle(did));
    const other = deps({ resolveHandle: async () => 'did:plc:someoneelse' });
    expect(await chooseExternalHandle(did, 'alice.example.com', other)).toBe(placeholderHandle(did));
  });

  it('does not take a handle already used here', async () => {
    expect(await chooseExternalHandle(did, 'alice.example.com', deps({ isTaken: async () => true }))).toBe(placeholderHandle(did));
  });

  it('falls back to the placeholder when the DID document names no handle', async () => {
    expect(await chooseExternalHandle(did, null, deps())).toBe('plc-abcdefghijklmnopqrstuvwx');
  });
});
