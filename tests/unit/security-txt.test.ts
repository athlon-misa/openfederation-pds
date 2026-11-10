/**
 * RFC 9116: /.well-known/security.txt names where to report vulnerabilities,
 * carries an Expires date under a year away, and is plain text.
 */
import { describe, it, expect } from 'vitest';
import { buildSecurityTxt } from '../../src/server/security-txt.js';

const NOW = new Date('2026-11-11T00:00:00Z');

describe('security.txt', () => {
  it('lists the project advisory form when no contact is configured', () => {
    const txt = buildSecurityTxt({ contacts: [], serviceUrl: 'https://pds.example.test', now: NOW });
    expect(txt).toContain('Contact: https://github.com/athlon-misa/openfederation-pds/security/advisories/new');
    expect(txt).toContain('Canonical: https://pds.example.test/.well-known/security.txt');
    expect(txt).toContain('Policy: https://github.com/athlon-misa/openfederation-pds/blob/main/SECURITY.md');
  });

  it('puts configured contacts first, as mailto for bare addresses', () => {
    const txt = buildSecurityTxt({ contacts: ['security@op.example', 'https://op.example/report'], serviceUrl: 'https://pds.example.test', now: NOW });
    const lines = txt.split('\n').filter((l) => l.startsWith('Contact: '));
    expect(lines[0]).toBe('Contact: mailto:security@op.example');
    expect(lines[1]).toBe('Contact: https://op.example/report');
  });

  it('expires in under a year, in RFC 3339 form', () => {
    const txt = buildSecurityTxt({ contacts: [], serviceUrl: 'https://pds.example.test', now: NOW });
    const expires = new Date(/^Expires: (.+)$/m.exec(txt)![1]);
    const days = (expires.getTime() - NOW.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(365);
  });

  it('drops contacts that are neither an email address nor https', () => {
    const txt = buildSecurityTxt({ contacts: ['javascript:alert(1)', 'http://plain.example', 'a@b.example'], serviceUrl: 'https://pds.example.test', now: NOW });
    expect(txt).not.toContain('javascript:');
    expect(txt).not.toContain('http://plain.example');
    expect(txt).toContain('Contact: mailto:a@b.example');
  });
});
