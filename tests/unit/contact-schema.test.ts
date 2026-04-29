/**
 * Issue #67 — contact graph schema smoke tests (RED first)
 *
 * Verifies:
 *  - DB tables contact_requests + contacts exist with the right columns
 *  - All 8 lexicon files (2 record + 6 XRPC) are present
 */
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db/client.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const LEXICON_DIR = join(process.cwd(), 'src/lexicon');

function lexiconPath(nsid: string) {
  return join(LEXICON_DIR, `${nsid}.json`);
}

function lexiconExists(nsid: string) {
  return existsSync(lexiconPath(nsid));
}

// ── Lexicon presence ─────────────────────────────────────────────────────────

describe('contact lexicons exist', () => {
  const lexicons = [
    'net.openfederation.contact.request',
    'net.openfederation.contact.contact',
    'net.openfederation.contact.sendRequest',
    'net.openfederation.contact.respondToRequest',
    'net.openfederation.contact.removeContact',
    'net.openfederation.contact.list',
    'net.openfederation.contact.listIncomingRequests',
    'net.openfederation.contact.listOutgoingRequests',
  ];

  for (const nsid of lexicons) {
    it(`${nsid}.json exists`, () => {
      expect(lexiconExists(nsid)).toBe(true);
    });
  }
});

// ── DB table: contact_requests ───────────────────────────────────────────────

describe('contact_requests table', () => {
  it('exists with expected columns', async () => {
    const result = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'contact_requests'
       ORDER BY ordinal_position`,
      [],
    );
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('from_did');
    expect(cols).toContain('to_did');
    expect(cols).toContain('rkey');
    expect(cols).toContain('note');
    expect(cols).toContain('created_at');
  });
});

// ── DB table: contacts ───────────────────────────────────────────────────────

describe('contacts table', () => {
  it('exists with expected columns', async () => {
    const result = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'contacts'
       ORDER BY ordinal_position`,
      [],
    );
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('user_did');
    expect(cols).toContain('contact_did');
    expect(cols).toContain('rkey');
    expect(cols).toContain('accepted_at');
    expect(cols).toContain('tags');
  });
});
