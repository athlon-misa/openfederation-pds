/**
 * `verifyApplication` — was a decided change legitimately applied? (#201)
 *
 * The decision verifier answers whether a decision was soundly *reached*; this
 * one answers whether it was soundly *carried out*. Every verdict is exercised,
 * because a taxonomy whose codes are never produced is a taxonomy nobody can
 * rely on.
 *
 * The scenarios build real signed repos (see the fixture), so a `legitimate`
 * verdict here is earned by signatures that verify and records that hash to the
 * CIDs they are cited under.
 */
import { describe, it, expect } from 'vitest';
import { verifyApplication } from '../../src/governance/verify-application.js';
import {
  OBJECTION_COLLECTION,
  PROPOSAL_COLLECTION,
  applyAtFrom,
} from '../../src/governance/decision-rules.js';
import { buildApplicationScenario } from './helpers/governance-application-fixture.js';
import { TestRepo } from './helpers/governance-decision-fixture.js';

describe('verifyApplication — the change was applied', () => {
  it('accepts an application at or after the published applyAt', async () => {
    const scenario = await buildApplicationScenario({ state: 'applied' });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('applied');
    expect(verdict.problems).toEqual([]);
    expect(verdict.summary.applyAt).toBe(scenario.applyAt);
    expect(verdict.summary.appliedAt).not.toBeNull();
  });

  it('accepts an immediate application when the community set no window', async () => {
    // `timelockHours: 0` applies in the resolving request, so there is no
    // applyAt and no timing claim to check — which the verdict says explicitly
    // rather than passing silently.
    const scenario = await buildApplicationScenario({ state: 'applied', noWindow: true });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('applied');
    expect(verdict.notes.map(n => n.code)).toContain('no-contest-window');
  });

  it('rejects an application made before the window closed', async () => {
    const scenario = await buildApplicationScenario({
      state: 'applied',
      appliedAt: '2026-01-01T02:00:00.000Z', // resolvedAt + 1h, window is 24h
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('early-application');
    expect(verdict.problems[0].message).toMatch(/before the applyAt/);
  });

  it('rejects an application made over a hold that had reached the threshold', async () => {
    const scenario = await buildApplicationScenario({
      state: 'applied',
      objections: [{ name: 'ada' }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('applied-over-objection');
    expect(verdict.summary.countableObjections).toBe(1);
  });

  it('lets an application stand over objections that do not reach the threshold', async () => {
    const scenario = await buildApplicationScenario({
      state: 'applied',
      objectionThreshold: 2,
      objections: [{ name: 'ada' }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('applied');
    expect(verdict.summary.objectionThreshold).toBe(2);
    expect(verdict.summary.countableObjections).toBe(1);
  });

  it('does not count an objection raised after the window closed', async () => {
    // The window is half-open: an objection at or after applyAt is late, and
    // lazy application must not turn a late objection into a timely one.
    const scenario = await buildApplicationScenario({
      state: 'applied',
      objections: [{ name: 'ada', atHours: 25 }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.summary.countableObjections).toBe(0);
  });

  it('does not count an objection naming a different decision', async () => {
    const scenario = await buildApplicationScenario({
      state: 'applied',
      objections: [{ name: 'ada', wrongDecision: true }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.summary.countableObjections).toBe(0);
  });
});

describe('verifyApplication — the change was held', () => {
  it('accepts a hold backed by a countable objection', async () => {
    const scenario = await buildApplicationScenario({
      state: 'objected',
      objections: [{ name: 'ada' }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('held');
    expect(verdict.summary.objectors).toHaveLength(1);
    // Structural countability is all an objection record can prove; the verdict
    // says so rather than implying the objector's entitlement was rechecked.
    expect(verdict.notes.map(n => n.code)).toContain('objector-eligibility-unverified');
  });

  it('rejects a hold the named objector\'s own repo contradicts', async () => {
    // The objector's repo is right here, signed, and contains no objection —
    // so the community is withholding a change on evidence that does not exist.
    const scenario = await buildApplicationScenario({
      state: 'objected',
      objections: [{ name: 'ada', cacheOnly: true }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('unevidenced-hold');
  });

  it('notes rather than accuses when the objector\'s repo was not supplied', async () => {
    // Same claim, but nothing contradicts it: an absent export proves nothing.
    const scenario = await buildApplicationScenario({
      state: 'objected',
      objections: [{ name: 'ada', withholdRepo: true }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('held');
    expect(verdict.problems).toEqual([]);
    expect(verdict.notes.map(n => n.code)).toContain('hold-unverified');
  });

  it('counts one hold per objector, taking the earliest record', async () => {
    const scenario = await buildApplicationScenario({
      state: 'objected',
      objectionThreshold: 2,
      objections: [{ name: 'ada', atHours: 2 }],
    });
    const ada = scenario.objectors.get('ada')!;
    await ada.put(OBJECTION_COLLECTION, '3lobjadasecond', {
      ...(scenario.proposal.value as any),
      $type: OBJECTION_COLLECTION,
      community: scenario.community.did,
      proposal: { uri: scenario.proposal.uri, cid: scenario.proposal.cid },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: scenario.proposal.uri.split('/').pop(),
      decision: (scenario.proposal.value as any).decision,
      createdAt: applyAtFrom(scenario.resolvedAt, 3),
    });

    const verdict = await verifyApplication(scenario.input());
    // Two records, one objector: the threshold of 2 is not reached by one
    // person objecting twice.
    expect(verdict.summary.countableObjections).toBe(1);
    expect(verdict.summary.objectors[0].createdAt).toBe(applyAtFrom(scenario.resolvedAt, 2));
  });

  it('ignores an objection in an export whose signature does not verify', async () => {
    const scenario = await buildApplicationScenario({
      state: 'objected',
      objections: [{ name: 'ada' }],
    });
    // Same repo, but the DID document offered for it carries someone else's key.
    const impostorKey = (await TestRepo.create('did:plc:impostoraaaaaaaaaaaaaa'));
    const input = scenario.input();
    const ada = scenario.objectors.get('ada')!;
    input.didDocuments = input.didDocuments.map(doc =>
      doc.id === ada.did ? { ...ada.didDoc(impostorKey.keypair) } : doc,
    );

    const verdict = await verifyApplication(input);
    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('forged-signature');
    // ...and the objection it held is not counted, because an unverified export
    // proves nothing about who wrote what is in it.
    expect(verdict.summary.countableObjections).toBe(0);
  });
});

describe('verifyApplication — nothing has finished', () => {
  it('reports a pending application without judging the window when no asOf is given', async () => {
    const scenario = await buildApplicationScenario({ state: 'pending-application' });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('pending');
    expect(verdict.code).toBe('pending-application');
  });

  it('reports an open window when asOf precedes applyAt', async () => {
    const scenario = await buildApplicationScenario({ state: 'pending-application' });
    const verdict = await verifyApplication(scenario.input({ asOf: '2026-01-01T02:00:00.000Z' }));

    expect(verdict.status).toBe('pending');
    expect(verdict.code).toBe('window-open');
  });

  it('reports a due application, not a defect, once the window has elapsed', async () => {
    // Application is lazy: the next interaction applies it. A verifier that
    // failed here would go red on every honest community with an idle proposal.
    const scenario = await buildApplicationScenario({ state: 'pending-application' });
    const verdict = await verifyApplication(scenario.input({ asOf: '2026-02-01T00:00:00.000Z' }));

    expect(verdict.status).toBe('pending');
    expect(verdict.code).toBe('application-due');
    expect(verdict.problems).toEqual([]);
  });

  it('holds a pending proposal whose objections already reached the threshold', async () => {
    const scenario = await buildApplicationScenario({
      state: 'pending-application',
      objections: [{ name: 'ada' }],
    });
    const verdict = await verifyApplication(scenario.input({ asOf: '2026-02-01T00:00:00.000Z' }));

    // The proposal has not been rewritten yet, but the signed objection records
    // decide the hold — exactly as `applyIfDue` decides it from the records
    // rather than from the proposal's cache.
    expect(verdict.status).toBe('pending');
    expect(verdict.code).toBe('application-due');
    expect(verdict.summary.countableObjections).toBe(1);
  });

  it('says there is nothing to apply for a rejected proposal', async () => {
    const scenario = await buildApplicationScenario({ state: 'rejected' });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('nothing-to-apply');
  });

  it('is indeterminate about a closed proposal that claims no application', async () => {
    // What the PDS writes when a passed change is refused as unapplicable — and
    // also what a silently skipped application looks like. The signed record
    // does not separate them, so neither does the verdict.
    const scenario = await buildApplicationScenario({ state: 'applied', appliedAt: null });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('indeterminate');
    expect(verdict.code).toBe('closed-unapplied');
  });
});

describe('verifyApplication — the evidence itself', () => {
  it('refuses a uri that is not a proposal record', async () => {
    const scenario = await buildApplicationScenario({ state: 'applied' });
    const verdict = await verifyApplication(scenario.input({
      proposal: { ...scenario.proposal, uri: `at://${scenario.community.did}/net.openfederation.governance.vote/x` },
    }));

    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('malformed-proposal');
  });

  it('reports missing evidence when the community export is absent', async () => {
    const scenario = await buildApplicationScenario({ state: 'applied' });
    const verdict = await verifyApplication(scenario.input({ repos: [], didDocuments: [] }));

    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('missing-evidence');
  });

  it('rejects a proposal cited at a CID the signed repo does not hold', async () => {
    const scenario = await buildApplicationScenario({ state: 'applied' });
    const verdict = await verifyApplication(scenario.input({
      proposal: { ...scenario.proposal, cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    }));

    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('tampered-evidence');
  });

  it('falls back to the default threshold, and says so, without a settings record', async () => {
    const scenario = await buildApplicationScenario({ state: 'applied', omitSettings: true });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.summary.thresholdFromSettings).toBe(false);
    expect(verdict.summary.objectionThreshold).toBe(1);
    expect(verdict.notes.map(n => n.code)).toContain('settings-unavailable');
  });

  it('notes when the proposal cache and the countable records disagree', async () => {
    const scenario = await buildApplicationScenario({
      state: 'objected',
      objectionThreshold: 1,
      objections: [{ name: 'ada' }, { name: 'bo', withholdRepo: true }],
    });
    const verdict = await verifyApplication(scenario.input());

    expect(verdict.status).toBe('legitimate');
    expect(verdict.summary.cachedObjections).toBe(2);
    expect(verdict.summary.countableObjections).toBe(1);
    expect(verdict.notes.map(n => n.code)).toContain('objection-count-drift');
  });
});
