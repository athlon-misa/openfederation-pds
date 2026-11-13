/**
 * src/config.ts reads the environment once, when first imported. The setup
 * wizard runs before the settings file it writes exists, and the real server
 * is imported after it, in the same process (#405). If anything the setup
 * mode imports reached src/config.ts, the server would start with the
 * configuration from before setup. This walks the static and dynamic imports
 * of the setup launcher and fails if config.ts is among them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function localImports(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith('.')) continue;
    const target = join(dirname(file), spec).replace(/\.js$/, '.ts');
    if (existsSync(target)) out.push(target);
  }
  return out;
}

function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...localImports(file));
  }
  return seen;
}

describe('setup mode never loads the server configuration', () => {
  it('nothing the setup launcher imports reaches src/config.ts', () => {
    const files = [...reach(join(ROOT, 'src/setup/launcher.ts'))].map((f) => f.slice(ROOT.length + 1));
    expect(files).toContain('src/setup/setup-app.ts');
    expect(files).not.toContain('src/config.ts');
    expect(files).not.toContain('src/db/client.ts');
  });

  it('src/index.ts imports the server only dynamically, after setup', () => {
    const text = readFileSync(join(ROOT, 'src/index.ts'), 'utf-8');
    expect(text).not.toMatch(/^import[^;]*from '\.\/(config|server\/index)\.js'/m);
    expect(text.indexOf('runSetupIfNeeded(')).toBeLessThan(text.indexOf("import('./config.js')"));
  });
});
