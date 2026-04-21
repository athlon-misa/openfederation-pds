/**
 * @vitest-environment happy-dom
 *
 * DOM unit tests for the vanilla `client.mountSignInButton` helper.
 * Everything is mocked at the client-boundary so we don't spin up a PDS.
 */
import { describe, it, expect, vi } from 'vitest';
import { OpenFederationClient } from '../../packages/openfederation-sdk/src/client.js';

function makeClient(overrides: Partial<OpenFederationClient> = {}): OpenFederationClient {
  // Build a real client with an unreachable serverUrl; we stub its methods so
  // fetch is never actually called.
  const base = new OpenFederationClient({
    serverUrl: 'http://test.invalid',
    partnerKey: 'ofp_test',
    storage: 'memory',
    autoRefresh: false,
  });
  Object.assign(base, overrides);
  return base;
}

describe('client.mountSignInButton', () => {
  it('appends a styled button to the target element', () => {
    const container = document.createElement('div');
    const client = makeClient();
    client.mountSignInButton(container, {
      chain: 'ethereum',
      audience: 'https://example.com',
      walletAddress: '0xabc',
      onSuccess: () => {},
    });
    const btn = container.querySelector('button[data-openfederation-signin]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.type).toBe('button');
    expect(btn.textContent).toBe('Sign in with OpenFederation');
    expect(btn.style.background).toBe('#111');
  });

  it('honors a custom label', () => {
    const container = document.createElement('div');
    const client = makeClient();
    client.mountSignInButton(container, {
      chain: 'ethereum',
      audience: 'https://example.com',
      walletAddress: '0xabc',
      label: 'Continue with OpenFederation',
      onSuccess: () => {},
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('Continue with OpenFederation');
  });

  it('calls onSuccess with the assertion on click', async () => {
    const container = document.createElement('div');
    const assertion = {
      didToken: 'a.b.c',
      walletProof: {
        message: 'msg', signature: 'sig',
        chain: 'ethereum' as const, walletAddress: '0xabc', chainIdCaip2: 'eip155:1',
      },
      did: 'did:plc:test',
      audience: 'https://example.com',
    };
    const client = makeClient({
      signInWithOpenFederation: vi.fn().mockResolvedValue(assertion),
    } as unknown as Partial<OpenFederationClient>);

    const onSuccess = vi.fn();
    client.mountSignInButton(container, {
      chain: 'ethereum',
      audience: 'https://example.com',
      walletAddress: '0xabc',
      onSuccess,
    });

    const btn = container.querySelector('button')!;
    btn.click();
    // Wait a microtask for the async click handler to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(client.signInWithOpenFederation).toHaveBeenCalledWith({
      chain: 'ethereum',
      walletAddress: '0xabc',
      audience: 'https://example.com',
      statement: undefined,
    });
    expect(onSuccess).toHaveBeenCalledWith(assertion);
  });

  it('routes errors through onError when provided', async () => {
    const container = document.createElement('div');
    const err = new Error('nope');
    const client = makeClient({
      signInWithOpenFederation: vi.fn().mockRejectedValue(err),
    } as unknown as Partial<OpenFederationClient>);

    const onError = vi.fn();
    client.mountSignInButton(container, {
      chain: 'solana',
      audience: 'https://dapp.example',
      walletAddress: 'Sol123',
      onSuccess: () => {},
      onError,
    });

    container.querySelector('button')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalledWith(err);
  });

  it('looks up the primary wallet when walletAddress is omitted', async () => {
    const container = document.createElement('div');
    const client = makeClient({
      listWalletLinks: vi.fn().mockResolvedValue({
        walletLinks: [
          { chain: 'ethereum', walletAddress: '0xETH', label: 'eth', linkedAt: '' },
          { chain: 'solana', walletAddress: 'SOL', label: 'sol', linkedAt: '' },
        ],
      }),
      signInWithOpenFederation: vi.fn().mockResolvedValue({
        didToken: 'j',
        walletProof: {
          message: '', signature: '', chain: 'ethereum' as const,
          walletAddress: '0xETH', chainIdCaip2: 'eip155:1',
        },
        did: 'did:plc:x',
        audience: 'https://example.com',
      }),
    } as unknown as Partial<OpenFederationClient>);

    client.mountSignInButton(container, {
      chain: 'ethereum',
      audience: 'https://example.com',
      onSuccess: () => {},
    });

    container.querySelector('button')!.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(client.signInWithOpenFederation).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: '0xETH' })
    );
  });

  it('destroy() removes the button from the DOM', () => {
    const container = document.createElement('div');
    const client = makeClient();
    const handle = client.mountSignInButton(container, {
      chain: 'ethereum',
      audience: 'https://example.com',
      walletAddress: '0xabc',
      onSuccess: () => {},
    });
    expect(container.querySelectorAll('button').length).toBe(1);
    handle.destroy();
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});
