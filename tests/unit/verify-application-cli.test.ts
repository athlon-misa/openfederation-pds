/**
 * `ofc governance verify-application`, end to end on real CAR exports (#201).
 *
 * The sibling of the `verify-decision` CLI test, and for the same reason: the
 * command is where the offline claim becomes usable by someone who is not us,
 * holding CAR files and a JSON file of DID documents and nothing else. So this
 * hands it exactly that — files on disk, no server, no database.
 *
 * The exit code carries most of the weight here. Only an illegitimate
 * application is a failure; a pending one is a state of the world, and a
 * command that exited non-zero on it would report every community with an open
 * contest window as broken.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildApplicationScenario,
  type ApplicationOpts,
  type ApplicationScenario,
} from './helpers/governance-application-fixture.js';

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

/** The community export plus every objector's, and the DID documents. */
async function exportEvidence(s: ApplicationScenario, dir: string): Promise<{ cars: string[]; docs: string }> {
  const repos = [s.community, ...s.objectors.values()];
  const cars: string[] = [];
  for (const repo of repos) {
    const file = join(dir, `${repo.did.replace(/:/g, '_')}.car`);
    writeFileSync(file, await repo.car());
    cars.push(file);
  }
  const docs = join(dir, 'did-docs.json');
  writeFileSync(docs, JSON.stringify(repos.map(r => r.didDoc()), null, 2));
  return { cars, docs };
}

async function verify(opts: ApplicationOpts, extra: string[] = []): Promise<CliResult & { scenario: ApplicationScenario }> {
  const dir = mkdtempSync(join(tmpdir(), 'ofc-verify-app-'));
  const scenario = await buildApplicationScenario(opts);
  const { cars, docs } = await exportEvidence(scenario, dir);
  const result = await runCli([
    '--json', 'governance', 'verify-application',
    '--car', ...cars, '--did-docs', docs, ...extra,
  ]);
  return { ...result, scenario };
}

describe('ofc governance verify-application', () => {
  it('verifies a legitimate application from CAR exports', async () => {
    const { code, stdout, scenario } = await verify({ state: 'applied' });

    expect(code).toBe(0);
    const verdict = JSON.parse(stdout);
    expect(verdict.status).toBe('legitimate');
    expect(verdict.code).toBe('applied');
    expect(verdict.summary.proposalUri).toBe(scenario.proposal.uri);
  }, 120_000);

  it('exits non-zero on a change applied before its window closed', async () => {
    const { code, stdout } = await verify({
      state: 'applied',
      appliedAt: '2026-01-01T02:00:00.000Z',
    });

    expect(code).toBe(1);
    const verdict = JSON.parse(stdout);
    expect(verdict.status).toBe('illegitimate');
    expect(verdict.code).toBe('early-application');
  }, 120_000);

  it('exits zero on a pending application, and reports the window as unevaluated', async () => {
    const { code, stdout } = await verify({ state: 'pending-application' });

    expect(code).toBe(0);
    expect(JSON.parse(stdout).code).toBe('pending-application');
  }, 120_000);

  it('judges the window against --as-of when one is given', async () => {
    const open = await verify({ state: 'pending-application' }, ['--as-of', '2026-01-01T02:00:00.000Z']);
    expect(open.code).toBe(0);
    expect(JSON.parse(open.stdout).code).toBe('window-open');

    const due = await verify({ state: 'pending-application' }, ['--as-of', '2026-02-01T00:00:00.000Z']);
    expect(due.code).toBe(0);
    expect(JSON.parse(due.stdout).code).toBe('application-due');
  }, 180_000);

  it('reports a hold and the objector who holds it, in human-readable output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofc-verify-app-'));
    const scenario = await buildApplicationScenario({ state: 'objected', objections: [{ name: 'ada' }] });
    const { cars, docs } = await exportEvidence(scenario, dir);

    const res = await runCli(['governance', 'verify-application', '--car', ...cars, '--did-docs', docs]);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/Application verifies against the evidence: held/);
    expect(res.stderr).toMatch(new RegExp(scenario.objectors.get('ada')!.did));
    // The honest caveat travels with the verdict rather than only living in the
    // source: entitlement to object is not re-derivable offline.
    expect(res.stderr).toMatch(/objector-eligibility-unverified/);
  }, 120_000);

  it('refuses to guess when the exports hold more than one proposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofc-verify-app-'));
    const scenario = await buildApplicationScenario({ state: 'applied' });
    await scenario.community.put('net.openfederation.community.proposal', '3laaaaproposal2', {
      ...(scenario.proposal.value as Record<string, unknown>),
    });
    const { cars, docs } = await exportEvidence(scenario, dir);

    const res = await runCli(['governance', 'verify-application', '--car', ...cars, '--did-docs', docs]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/pass --proposal <rkey> to pick one/);

    const picked = await runCli([
      '--json', 'governance', 'verify-application',
      '--car', ...cars, '--did-docs', docs, '--proposal', '3laaaaproposal2',
    ]);
    expect(picked.code).toBe(0);
  }, 120_000);
});
