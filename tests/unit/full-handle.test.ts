import { describe, it, expect } from 'vitest';
import { config } from '../../src/config.js';
import { fullHandle, localHandle } from '../../src/auth/utils.js';
import { placeholderHandle } from '../../src/oauth/external-handle.js';

// #411: responses give AT Protocol handles in full; accounts store the short form.
describe('fullHandle', () => {
  const suffix = config.handleSuffix;

  it('adds this server\'s handle domain to a stored short name', () => {
    expect(fullHandle('elena')).toBe(`elena${suffix}`);
    expect(fullHandle('night-desk-2')).toBe(`night-desk-2${suffix}`);
  });

  it('leaves a handle that already has a domain alone (stored full, or another server\'s)', () => {
    expect(fullHandle(`elena${suffix}`)).toBe(`elena${suffix}`);
    expect(fullHandle('alice.bsky.social')).toBe('alice.bsky.social');
  });

  it('leaves an external account\'s placeholder alone: that name was never issued here', () => {
    const did = 'did:plc:abcdefghijklmnopqrstuvwx';
    expect(fullHandle(placeholderHandle(did))).toBe(placeholderHandle(did));
    expect(fullHandle(placeholderHandle('did:web:example.com'))).toBe('web-example.com');
    expect(fullHandle(placeholderHandle('did:web:localhost%3A3000'))).toBe('web-localhost%3A3000');
  });

  it('leaves a DID alone (a service-auth caller has no handle)', () => {
    expect(fullHandle('did:plc:abcdefghijklmnopqrstuvwx')).toBe('did:plc:abcdefghijklmnopqrstuvwx');
  });

  it('passes empty values through', () => {
    expect(fullHandle(null)).toBeNull();
    expect(fullHandle(undefined)).toBeNull();
    expect(fullHandle('')).toBe('');
  });

  it('is undone by localHandle, which sign-in uses', () => {
    expect(localHandle(fullHandle('elena'))).toBe('elena');
  });
});
