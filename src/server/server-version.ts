/**
 * The one copy of the server version. Four route handlers used to carry the
 * string '1.0.0' by hand, and every one of them was still saying it three
 * releases later — a version constant that has to be updated in five places
 * is four places wrong.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const SERVER_VERSION: string = (() => {
  // Walk up from wherever this file executes — src/server in dev, a deeper
  // dist/ path when compiled — until the repo's package.json appears. A
  // relative hop count would be correct in exactly one of those layouts.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (parsed?.name && parsed?.version) return parsed.version;
    } catch { /* keep climbing */ }
    dir = join(dir, '..');
  }
  return '0.0.0';
})();
