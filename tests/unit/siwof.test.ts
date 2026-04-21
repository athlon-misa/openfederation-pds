import { describe, it, expect } from 'vitest';
import {
  buildSiwofMessage,
  parseSiwofMessage,
  normalizeSiwofAudience,
  resolveChainIdCaip2,
  toCaip10,
} from '../../src/identity/siwof.js';

describe('CAIP-122 / SIWOF message builder', () => {
  it('builds + parses a full message round-trip', () => {
    const f = {
      domain: 'game.example.com',
      accountCaip10: 'eip155:1:0xabcdef0123456789abcdef0123456789abcdef01',
      chainIdCaip2: 'eip155:1',
      uri: 'https://game.example.com/login',
      nonce: 'abc123',
      issuedAt: '2026-04-21T12:00:00Z',
      expirationTime: '2026-04-21T12:05:00Z',
      statement: 'Welcome to Game. Sign to continue.',
      resources: ['https://game.example.com/terms'],
      version: '1' as const,
    };
    const text = buildSiwofMessage(f);
    expect(text).toContain('game.example.com wants you to sign in with your Ethereum account');
    expect(text).toContain('0xabcdef0123456789abcdef0123456789abcdef01');
    expect(text).toContain('URI: https://game.example.com/login');
    expect(text).toContain('Nonce: abc123');
    expect(text).toContain('Welcome to Game. Sign to continue.');
    expect(text).toContain('- https://game.example.com/terms');

    const parsed = parseSiwofMessage(text);
    expect(parsed.domain).toBe('game.example.com');
    expect(parsed.accountCaip10).toBe('eip155:1:0xabcdef0123456789abcdef0123456789abcdef01');
    expect(parsed.chainIdCaip2).toBe('eip155:1');
    expect(parsed.nonce).toBe('abc123');
    expect(parsed.statement).toBe('Welcome to Game. Sign to continue.');
    expect(parsed.resources).toEqual(['https://game.example.com/terms']);
  });

  it('round-trips a minimal Solana message', () => {
    const f = {
      domain: 'app.example.com',
      accountCaip10: 'solana:mainnet:CcaBZxp3sYjoeURVq6W7C7Ce9A5LAc8o6hAj4v4FjsHV',
      chainIdCaip2: 'solana:mainnet',
      uri: 'https://app.example.com',
      nonce: '00ff',
      issuedAt: '2026-04-21T13:00:00Z',
      version: '1' as const,
    };
    const text = buildSiwofMessage(f);
    expect(text).toContain('Solana account');
    const parsed = parseSiwofMessage(text);
    expect(parsed.chainIdCaip2).toBe('solana:mainnet');
    expect(parsed.statement).toBeUndefined();
    expect(parsed.resources).toBeUndefined();
  });

  it('rejects a truncated / malformed message', () => {
    expect(() => parseSiwofMessage('hello')).toThrow();
    // Missing required "Chain ID", "Nonce", "Issued At".
    expect(() =>
      parseSiwofMessage(
        'domain wants you to sign in with your Ethereum account:\n0xabc\n\nURI: x\nVersion: 1\nSomething: else\nAnother: line'
      )
    ).toThrow(/missing required fields/i);
  });
});

describe('normalizeSiwofAudience', () => {
  it('lowercases host, drops trailing slash, preserves path', () => {
    expect(normalizeSiwofAudience('https://Example.COM/').uri).toBe('https://example.com');
    expect(normalizeSiwofAudience('https://example.com/path').uri).toBe('https://example.com/path');
  });
  it('rejects non-http(s)', () => {
    expect(() => normalizeSiwofAudience('file:///x')).toThrow();
  });
  it('rejects missing input', () => {
    expect(() => normalizeSiwofAudience('')).toThrow();
  });
});

describe('CAIP-2 chain-id resolution', () => {
  it('default eip155:1 for ethereum', () => {
    expect(resolveChainIdCaip2('ethereum')).toBe('eip155:1');
  });
  it('default solana:mainnet for solana', () => {
    expect(resolveChainIdCaip2('solana')).toBe('solana:mainnet');
  });
  it('honors explicit override', () => {
    expect(resolveChainIdCaip2('ethereum', 'eip155:137')).toBe('eip155:137');
  });
});

describe('toCaip10', () => {
  it('concatenates chain id + address with a colon', () => {
    expect(toCaip10('eip155:1', '0xabc')).toBe('eip155:1:0xabc');
    expect(toCaip10('solana:mainnet', '9xSol')).toBe('solana:mainnet:9xSol');
  });
});
