#!/usr/bin/env node
/**
 * Validate that all lexicon JSON files in src/lexicon/ have required fields,
 * including a valid revision integer >= 1 after the id field.
 *
 * Exits with code 1 if any validation errors are found, 0 on success.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEXICON_DIR = path.resolve(__dirname, '../src/lexicon');

interface LexiconFile {
  lexicon?: unknown;
  id?: unknown;
  revision?: unknown;
  [key: string]: unknown;
}

const files = fs.readdirSync(LEXICON_DIR).filter(f => f.endsWith('.json')).sort();

const errors: string[] = [];

for (const file of files) {
  const filePath = path.join(LEXICON_DIR, file);
  let obj: LexiconFile;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    obj = JSON.parse(raw) as LexiconFile;
  } catch (e) {
    errors.push(`${file}: Failed to parse JSON — ${(e as Error).message}`);
    continue;
  }

  if (obj.lexicon === undefined) {
    errors.push(`${file}: Missing required field "lexicon"`);
  }

  if (obj.id === undefined) {
    errors.push(`${file}: Missing required field "id"`);
  }

  if (obj.revision === undefined) {
    errors.push(`${file}: Missing required field "revision"`);
  } else if (!Number.isInteger(obj.revision) || (obj.revision as number) < 1) {
    errors.push(`${file}: "revision" must be an integer >= 1 (got ${JSON.stringify(obj.revision)})`);
  }
}

if (errors.length > 0) {
  console.error(`Lexicon validation FAILED — ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  process.exit(1);
} else {
  console.log(`Lexicon validation passed — ${files.length} file(s) validated.`);
  process.exit(0);
}
