import { describe, expect, it } from 'vitest';
import {
  getDeclaredErrorCodes,
  validateTypedXrpcInput,
  validateXrpcInput,
  validateXrpcOutput,
} from '../../src/lexicon/runtime.js';
import {
  lexiconContracts,
  type NetOpenfederationCommunityJoinInput,
} from '../../src/lexicon/generated.js';

describe('lexicon runtime validators', () => {
  it('accepts input declared by a procedure lexicon', () => {
    const result = validateXrpcInput('net.openfederation.community.join', {
      did: 'did:plc:community',
      kind: 'player',
      tags: ['captain'],
      attributes: { number: 9 },
    });

    expect(result.ok).toBe(true);
  });

  it('rejects undeclared procedure input fields', () => {
    const result = validateXrpcInput('net.openfederation.community.join', {
      did: 'did:plc:community',
      surprise: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('surprise');
    }
  });

  it('treats empty generated object schemas as permissive JSON object contracts', () => {
    const result = validateXrpcInput('net.openfederation.account.changePassword', {
      currentPassword: 'old',
      newPassword: 'new',
    });

    expect(result.ok).toBe(true);
  });

  it('validates query parameters while allowing numeric strings from Express', () => {
    const result = validateXrpcInput('net.openfederation.community.listMembers', {
      did: 'did:plc:community',
      limit: '25',
      offset: '0',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects missing required query parameters', () => {
    const result = validateXrpcInput('net.openfederation.community.listMembers', {
      limit: '25',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('did');
    }
  });

  it('can validate lexicon-declared outputs', () => {
    const result = validateXrpcOutput('net.openfederation.community.join', {
      status: 'joined',
    });

    expect(result.ok).toBe(true);
  });

  it('exposes generated contract metadata as the runtime error source', () => {
    expect(lexiconContracts['net.openfederation.community.join'].errors).toContain('AlreadyMember');
    expect(getDeclaredErrorCodes('net.openfederation.community.join').has('AlreadyMember')).toBe(true);
  });

  it('narrows validated input to the generated TypeScript contract', () => {
    const result = validateTypedXrpcInput('net.openfederation.community.join', {
      did: 'did:plc:community',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const input: NetOpenfederationCommunityJoinInput = result.value!;
      expect(input.did).toBe('did:plc:community');
    }
  });
});
