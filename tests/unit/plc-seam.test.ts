import { describe, it, expect, afterEach } from 'vitest';
import {
  registerDidPlc,
  resolveFromPlc,
  setPlcClientForTests,
  type PlcDirectoryClient,
} from '../../src/identity/plc-client.js';

afterEach(() => setPlcClientForTests(null));

describe('PLC client seam', () => {
  it('routes registerDidPlc through the injected client', async () => {
    const calls: string[] = [];
    const fake: PlcDirectoryClient = {
      async registerDidPlc(opts) {
        calls.push(opts.handle);
        return 'did:plc:faked123';
      },
      async resolveFromPlc() {
        return null;
      },
    };
    setPlcClientForTests(fake);
    const did = await registerDidPlc({
      signingKey: {} as any,
      rotationKeys: [],
      handle: 'alice.test',
      pdsEndpoint: 'https://pds.test',
    });
    expect(did).toBe('did:plc:faked123');
    expect(calls).toEqual(['alice.test']);
  });

  it('routes resolveFromPlc through the injected client', async () => {
    setPlcClientForTests({
      async registerDidPlc() { return 'did:plc:x'; },
      async resolveFromPlc(did) { return { id: did }; },
    });
    expect(await resolveFromPlc('did:plc:abc')).toEqual({ id: 'did:plc:abc' });
  });
});
