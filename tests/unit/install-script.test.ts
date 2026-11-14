/**
 * deploy/install.sh carries its own copies of the appliance's compose.yaml
 * and Caddyfile, so one downloaded file is all a server needs (#405). They
 * must stay exact copies of deploy/appliance/.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const script = readFileSync(resolve(root, 'deploy/install.sh'), 'utf-8');

function embedded(marker: string): string {
  const start = script.indexOf(`<<'${marker}'\n`);
  expect(start, `heredoc ${marker} in install.sh`).toBeGreaterThan(-1);
  const body = script.slice(script.indexOf('\n', start) + 1);
  const end = body.indexOf(`\n${marker}\n`);
  expect(end, `end of heredoc ${marker}`).toBeGreaterThan(-1);
  return body.slice(0, end + 1);
}

describe('deploy/install.sh', () => {
  it('embeds deploy/appliance/compose.yaml exactly', () => {
    expect(embedded('OPENFEDERATION_COMPOSE_YAML')).toBe(readFileSync(resolve(root, 'deploy/appliance/compose.yaml'), 'utf-8'));
  });

  it('embeds deploy/appliance/Caddyfile exactly', () => {
    expect(embedded('OPENFEDERATION_CADDYFILE')).toBe(readFileSync(resolve(root, 'deploy/appliance/Caddyfile'), 'utf-8'));
  });

  it('is strict bash and never pipes a download into a shell', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).not.toMatch(/curl[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/);
    expect(script).not.toMatch(/wget[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/);
  });
});
