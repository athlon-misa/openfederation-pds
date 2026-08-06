/**
 * Import boundary: modules import core; core never imports modules (#195).
 *
 * This supersedes the earlier comment-stripping grep for `/chain/i` in core
 * files, which asserted the symptom (no chain vocabulary) rather than the rule
 * (no chain dependency), and broke whenever a comment mentioned the module.
 *
 * Two assertions:
 *   1. The repository currently satisfies the rule.
 *   2. The checker genuinely rejects each class of violation — proven against
 *      a synthetic source tree, so no real file has to be corrupted.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findBoundaryViolations } from '../../scripts/check-import-boundaries.js';

/** Build a throwaway `src/` tree and run the checker over it. */
function checkTree(files: Record<string, string>): ReturnType<typeof findBoundaryViolations> {
  const root = mkdtempSync(join(tmpdir(), 'boundary-'));
  try {
    for (const [relPath, source] of Object.entries(files)) {
      const full = join(root, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, source);
    }
    return findBoundaryViolations(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('import boundaries', () => {
  it('the repository has no core -> module imports', () => {
    expect(findBoundaryViolations()).toEqual([]);
  });

  it('rejects a core file importing module internals', () => {
    const violations = checkTree({
      'src/governance/enforcement.ts': "import { x } from '../modules/chain/evm-adapter.js';\n",
      'src/modules/chain/evm-adapter.ts': 'export const x = 1;\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/core must never depend on a module/);
  });

  it('rejects a core file importing a module entry point', () => {
    const violations = checkTree({
      'src/api/some-endpoint.ts': "import { x } from '../modules/chain/index.js';\n",
      'src/modules/chain/index.ts': 'export const x = 1;\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/core must never depend on a module/);
  });

  it('rejects a composition root reaching past the module entry point', () => {
    const violations = checkTree({
      'src/server/index.ts': "import { x } from '../modules/chain/oracle-auth.js';\n",
      'src/modules/chain/oracle-auth.ts': 'export const x = 1;\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/module internals/);
  });

  it('rejects one module importing another', () => {
    const violations = checkTree({
      'src/modules/chain/oracle-auth.ts': "import { y } from '../other/thing.js';\n",
      'src/modules/other/thing.ts': 'export const y = 1;\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/modules must not depend on each other/);
  });

  it('allows the composition roots to wire a module through its entry point', () => {
    expect(checkTree({
      'src/server/index.ts': "import { x } from '../modules/chain/index.js';\n",
      'src/server/handler-registry.ts': "import { x } from '../modules/chain/index.js';\n",
      'src/modules/chain/index.ts': 'export const x = 1;\n',
    })).toEqual([]);
  });

  it('allows a module to import core and its own internals', () => {
    expect(checkTree({
      'src/db/client.ts': 'export const query = 1;\n',
      'src/modules/chain/oracle-auth.ts':
        "import { query } from '../../db/client.js';\nimport { k } from './oracle-keys.js';\n",
      'src/modules/chain/oracle-keys.ts': 'export const k = 1;\n',
    })).toEqual([]);
  });

  it('catches dynamic imports too', () => {
    const violations = checkTree({
      'src/governance/enforcement.ts':
        "export async function f() { return import('../modules/chain/index.js'); }\n",
      'src/modules/chain/index.ts': 'export const x = 1;\n',
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/core must never depend on a module/);
  });
});
