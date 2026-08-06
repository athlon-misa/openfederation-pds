import { describe, it, expect, afterEach } from 'vitest';
import { enforceGovernance } from '../../src/governance/enforcement.js';
import { registerAttestor, clearAttestors } from '../../src/governance/attestor.js';
import type { GovernanceProof, VerificationResult } from '../../src/governance/attestor.js';

/**
 * enforceGovernance() gains a single optional hook into the attestor
 * registry (Task #190). It must never change a governance outcome based on
 * whether external verification was requested, or on attestor presence,
 * success, or failure — the registry is purely something a caller MAY
 * consult; it is never an authority core depends on.
 *
 * These tests use a community DID with no settings record, so
 * enforceGovernance falls through to defaults (benevolent-dictator model,
 * default protected collections) — deterministic and DB-light.
 */
describe('enforceGovernance attestor hook', () => {
  const communityDid = 'did:plc:no-such-community-attestor-hook';
  const collection = 'net.openfederation.community.settings';
  const action = 'write' as const;
  const proof: GovernanceProof = {
    chainId: 'eip155:attestor-hook-test',
    transactionHash: '0xhook',
  };

  afterEach(() => {
    clearAttestors();
  });

  it('produces the same outcome whether or not attestation is requested (no attestor registered)', async () => {
    const baseline = await enforceGovernance(communityDid, collection, action);
    const withAttestation = await enforceGovernance(communityDid, collection, action, null, {
      chainId: proof.chainId,
      proof,
    });

    expect(withAttestation).toEqual(baseline);
  });

  it('produces the same outcome when a registered attestor verifies successfully', async () => {
    const baseline = await enforceGovernance(communityDid, collection, action);

    let called = false;
    registerAttestor({
      chainId: proof.chainId,
      name: 'Test Attestor',
      async verifyProof(): Promise<VerificationResult> {
        called = true;
        return { verified: true };
      },
    });

    const result = await enforceGovernance(communityDid, collection, action, null, {
      chainId: proof.chainId,
      proof,
    });

    expect(called).toBe(true);
    expect(result).toEqual(baseline);
  });

  it('produces the same outcome when a registered attestor throws', async () => {
    const baseline = await enforceGovernance(communityDid, collection, action);

    registerAttestor({
      chainId: proof.chainId,
      name: 'Throwing Attestor',
      async verifyProof(): Promise<VerificationResult> {
        throw new Error('simulated attestor failure');
      },
    });

    await expect(
      enforceGovernance(communityDid, collection, action, null, {
        chainId: proof.chainId,
        proof,
      })
    ).resolves.toEqual(baseline);
  });

  it('does not consult the registry when no chainId/attestor is requested', async () => {
    let called = false;
    registerAttestor({
      chainId: 'eip155:some-other-chain',
      name: 'Unrelated Attestor',
      async verifyProof(): Promise<VerificationResult> {
        called = true;
        return { verified: true };
      },
    });

    await enforceGovernance(communityDid, collection, action);

    expect(called).toBe(false);
  });
});
