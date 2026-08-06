/**
 * `ofc governance verify-decision`, end to end on real CAR exports (#196).
 *
 * The CLI is the point at which the offline claim becomes usable by someone who
 * is not us: they get CAR files and a JSON file of DID documents, and nothing
 * else. So this test hands the command exactly that — files on disk, no server,
 * no database — and checks it both accepts a sound decision and refuses a
 * tampered one with the right reason and a non-zero exit code.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PROPOSAL_COLLECTION,
  VOTE_COLLECTION,
} from '../../src/governance/decision-rules.js';
import { buildScenario, PROPOSAL_RKEY, type Scenario } from './helpers/governance-decision-fixture.js';

const run = promisify(execFile);

interface CliResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--no-warnings', '--loader', 'ts-node/esm', 'cli/ofc.ts', ...args],
      { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' } },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Export every repo in the scenario as a CAR plus a DID-document file. */
async function exportEvidence(s: Scenario, dir: string): Promise<string[]> {
  const repos = [s.community, ...s.voters.map(v => v.repo), ...s.extraVoters.map(v => v.repo)];
  const cars: string[] = [];
  for (const repo of repos) {
    const file = join(dir, `${repo.did.replace(/:/g, '_')}.car`);
    writeFileSync(file, await repo.car());
    cars.push(file);
  }
  writeFileSync(join(dir, 'did-docs.json'), JSON.stringify(repos.map(r => r.didDoc()), null, 2));
  return cars;
}

describe('ofc governance verify-decision', () => {
  it('verifies a sound decision from CAR exports and refuses a tampered one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofc-verify-'));
    const s = await buildScenario();
    const cars = await exportEvidence(s, dir);
    const docs = join(dir, 'did-docs.json');

    const ok = await runCli(['--json', 'governance', 'verify-decision', '--car', ...cars, '--did-docs', docs]);
    expect(ok.stderr).not.toMatch(/\[error\]/i);
    expect(ok.code).toBe(0);
    const verdict = JSON.parse(ok.stdout);
    expect(verdict.status).toBe('valid');
    expect(verdict.summary.verifiedVotes).toBe(3);
    expect(verdict.summary.decisionUri).toBe(s.decision.uri);

    // Someone rewrites a counted vote in the voter's repo and re-exports.
    const alice = s.voters[0];
    await alice.repo.put(VOTE_COLLECTION, alice.rkey, {
      $type: VOTE_COLLECTION,
      community: s.community.did,
      proposal: { uri: s.proposalUri, cid: (s.proposal.value.cidChain as string[])[0] },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: PROPOSAL_RKEY,
      vote: 'against',
      createdAt: alice.castAt,
    });
    const tamperedCars = await exportEvidence(s, dir);

    const bad = await runCli(['--json', 'governance', 'verify-decision', '--car', ...tamperedCars, '--did-docs', docs]);
    expect(bad.code).toBe(1);
    const badVerdict = JSON.parse(bad.stdout);
    expect(badVerdict.status).toBe('invalid');
    expect(badVerdict.code).toBe('tampered-vote');
  }, 120_000);

  it('reports human-readable output and names the collections it looked in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofc-verify-'));
    const s = await buildScenario({ cacheOnly: ['did:plc:norepoaaaaaaaaaaaaa'] });
    const cars = await exportEvidence(s, dir);

    const res = await runCli([
      'governance', 'verify-decision',
      '--car', ...cars,
      '--did-docs', join(dir, 'did-docs.json'),
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/Decision verifies against the evidence it cites/);
    // A disclosed evidence gap is reported, not treated as a failure.
    expect(res.stderr).toMatch(/declared gap/);
    expect(res.stdout).toMatch(new RegExp(PROPOSAL_RKEY));
  }, 120_000);

  it('refuses to guess when the exports hold more than one decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofc-verify-'));
    const s = await buildScenario();
    await s.community.put('net.openfederation.governance.decision', '3laaaadecision2', {
      ...s.decision.value,
      supersedes: { uri: s.decision.uri, cid: s.decision.cid },
    });
    const cars = await exportEvidence(s, dir);

    const res = await runCli([
      'governance', 'verify-decision',
      '--car', ...cars,
      '--did-docs', join(dir, 'did-docs.json'),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/pass --decision <rkey> to pick one/);

    // Naming one resolves the ambiguity, and the earlier decision is reported
    // as superseded rather than as short of evidence.
    const picked = await runCli([
      '--json', 'governance', 'verify-decision',
      '--car', ...cars,
      '--did-docs', join(dir, 'did-docs.json'),
      '--decision', '3laaaadecision1',
    ]);
    expect(picked.code).toBe(0);
    expect(JSON.parse(picked.stdout).status).toBe('superseded');
  }, 120_000);
});
