/**
 * OAuth sign-in and authorization are logged, but not with the user's IP
 * address: that is personal data the log has no retention rule for, and the
 * account's DID is enough to trace an event.
 */
import { describe, it, expect, vi } from 'vitest';
import { oauthLogHooks } from '../../src/oauth/oauth-setup.js';

function captured(run: () => unknown): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
  return Promise.resolve(run()).then(() => lines.join('\n')).finally(() => spy.mockRestore());
}

describe('OAuth log lines', () => {
  it('sign-in names the account but not where it signed in from', async () => {
    const logged = await captured(() => oauthLogHooks.onSignedIn({
      account: { sub: 'did:plc:someone' },
      deviceMetadata: { ipAddress: '203.0.113.42', userAgent: 'Mozilla/5.0 (secret UA)' },
    } as never));
    expect(logged).toContain('did:plc:someone');
    expect(logged).not.toContain('203.0.113.42');
    expect(logged).not.toContain('secret UA');
  });

  it('authorization names the account and the client', async () => {
    const logged = await captured(() => oauthLogHooks.onAuthorized({
      account: { sub: 'did:plc:someone' },
      client: { id: 'https://app.example.test/client-metadata.json' },
    } as never));
    expect(logged).toContain('did:plc:someone');
    expect(logged).toContain('https://app.example.test/client-metadata.json');
  });
});
