/**
 * E2E: Lexicon Revisions
 *
 * Validates that all lexicon JSON files in src/lexicon/ have proper
 * revision tracking fields and follow the expected schema structure.
 * No PLC directory required.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const LEXICON_DIR = join(process.cwd(), 'src', 'lexicon');

describe('Lexicon Revisions', () => {
  const files = readdirSync(LEXICON_DIR).filter(f => f.endsWith('.json'));

  it('step 1: every lexicon JSON has a revision integer >= 1', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = JSON.parse(readFileSync(join(LEXICON_DIR, file), 'utf-8'));
      expect(content.revision, `${file} missing or invalid revision`).toBeTypeOf('number');
      expect(content.revision, `${file} revision must be >= 1`).toBeGreaterThanOrEqual(1);
    }
  });

  it('step 2: every lexicon JSON has lexicon and id fields', () => {
    for (const file of files) {
      const content = JSON.parse(readFileSync(join(LEXICON_DIR, file), 'utf-8'));
      expect(content.lexicon, `${file} missing lexicon field`).toBeDefined();
      expect(content.id, `${file} missing id field`).toBeDefined();
      expect(content.lexicon, `${file} lexicon should be 1`).toBe(1);
      expect(typeof content.id, `${file} id should be a string`).toBe('string');
    }
  });

  it('step 3: issueAttestation has revision 3', () => {
    const content = JSON.parse(
      readFileSync(join(LEXICON_DIR, 'net.openfederation.community.issueAttestation.json'), 'utf-8')
    );
    expect(content.revision).toBe(3);
  });

  it('step 4: revision appears after id in key order', () => {
    for (const file of files) {
      const raw = readFileSync(join(LEXICON_DIR, file), 'utf-8');
      const content = JSON.parse(raw);
      const keys = Object.keys(content);
      const idIndex = keys.indexOf('id');
      const revisionIndex = keys.indexOf('revision');
      expect(idIndex, `${file}: id key not found`).toBeGreaterThanOrEqual(0);
      expect(revisionIndex, `${file}: revision key not found`).toBeGreaterThanOrEqual(0);
      expect(revisionIndex, `${file}: revision should appear after id`).toBeGreaterThan(idIndex);
    }
  });
});
