/**
 * Dashboard Explore page helpers for community.discover: links are built only
 * from http(s) URLs, whatever a peer sent.
 */
import { describe, it, expect } from 'vitest';
import { httpUrl, hostLabel, peerErrorLabel } from '../../web-interface/src/lib/discovery.js';

describe('httpUrl', () => {
  it('accepts http and https origins and paths', () => {
    expect(httpUrl('https://peer.example')?.href).toBe('https://peer.example/');
    expect(httpUrl('http://localhost:8080/')?.host).toBe('localhost:8080');
    expect(httpUrl('HTTPS://Peer.Example/pds')?.hostname).toBe('peer.example');
  });

  it('refuses anything else', () => {
    for (const v of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://peer.example',
      '//peer.example',
      'peer.example',
      '',
      '   ',
      'https://',
      undefined,
      null,
      42,
      { href: 'https://peer.example' },
    ]) {
      expect(httpUrl(v), String(v)).toBeNull();
    }
  });

  it('refuses URLs carrying credentials', () => {
    expect(httpUrl('https://user:pass@peer.example')).toBeNull();
  });
});

describe('hostLabel', () => {
  it('names the host of an http(s) URL, else returns the value as text', () => {
    expect(hostLabel('https://peer.example:8443/x')).toBe('peer.example:8443');
    expect(hostLabel('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
});

describe('peerErrorLabel', () => {
  it('describes known errors and passes through unknown ones', () => {
    expect(peerErrorLabel('Timeout')).toBe('timed out');
    expect(peerErrorLabel('ResponseTooLarge')).toBe('response too large');
    expect(peerErrorLabel('SomethingNew')).toBe('SomethingNew');
    expect(peerErrorLabel(undefined)).toBe('no answer');
  });
});
