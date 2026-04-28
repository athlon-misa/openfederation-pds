import { readdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  isStandardXrpcErrorCode,
} from '../../src/xrpc/errors.js';

function walkTypescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypescriptFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function loadDeclaredErrors(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const file of readdirSync(join(process.cwd(), 'src', 'lexicon'))) {
    if (!file.endsWith('.json')) continue;
    const doc = JSON.parse(readFileSync(join(process.cwd(), 'src', 'lexicon', file), 'utf-8'));
    const id = doc.id;
    if (typeof id !== 'string') continue;
    result.set(
      id,
      new Set((doc.defs?.main?.errors ?? []).map((error: { name?: string }) => error.name)),
    );
  }
  return result;
}

describe('XRPC handler error contract', () => {
  it('has a lexicon contract for every API handler', () => {
    const declaredByNsid = loadDeclaredErrors();
    const missing = walkTypescriptFiles(join(process.cwd(), 'src', 'api'))
      .map((file) => basename(file, '.ts'))
      .filter((nsid) => !declaredByNsid.has(nsid));

    expect(missing).toEqual([]);
  });

  it('keeps literal handler errors declared for handlers that have lexicons', () => {
    const declaredByNsid = loadDeclaredErrors();
    const misses: string[] = [];
    const errorLiteralPattern = /error:\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g;

    for (const file of walkTypescriptFiles(join(process.cwd(), 'src', 'api'))) {
      const nsid = basename(file, '.ts');
      const declared = declaredByNsid.get(nsid);
      if (!declared) continue;

      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(errorLiteralPattern)) {
        const code = match[1];
        if (isStandardXrpcErrorCode(code)) continue;
        if (!declared.has(code)) {
          misses.push(`${file}: ${code}`);
        }
      }
    }

    expect(misses).toEqual([]);
  });
});
