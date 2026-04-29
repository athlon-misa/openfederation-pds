/**
 * Issues #68–#72 — schema smoke tests (RED first)
 *
 * Verifies lexicons and DB tables introduced by the contact graph extensions.
 */
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db/client.js';
import { existsSync } from 'fs';
import { join } from 'path';

const LEXICON_DIR = join(process.cwd(), 'src/lexicon');
function lexiconExists(nsid: string) {
  return existsSync(join(LEXICON_DIR, `${nsid}.json`));
}

// ── #68 withdrawRequest ──────────────────────────────────────────────────────

describe('#68 withdrawRequest lexicon', () => {
  it('net.openfederation.contact.withdrawRequest.json exists', () => {
    expect(lexiconExists('net.openfederation.contact.withdrawRequest')).toBe(true);
  });
});

// ── #71 block list ───────────────────────────────────────────────────────────

describe('#71 block lexicons', () => {
  const lexicons = [
    'net.openfederation.contact.block',
    'net.openfederation.contact.unblock',
    'net.openfederation.contact.listBlocks',
  ];
  for (const nsid of lexicons) {
    it(`${nsid}.json exists`, () => {
      expect(lexiconExists(nsid)).toBe(true);
    });
  }
});

describe('#71 contact_blocks table', () => {
  it('exists with expected columns', async () => {
    const result = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'contact_blocks' ORDER BY ordinal_position`,
      [],
    );
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('blocker_did');
    expect(cols).toContain('blocked_did');
    expect(cols).toContain('rkey');
    expect(cols).toContain('created_at');
  });
});

// ── #72 mutual contacts / FoF ────────────────────────────────────────────────

describe('#72 discovery lexicons', () => {
  const lexicons = [
    'net.openfederation.contact.listMutualContacts',
    'net.openfederation.contact.listFriendOfFriends',
  ];
  for (const nsid of lexicons) {
    it(`${nsid}.json exists`, () => {
      expect(lexiconExists(nsid)).toBe(true);
    });
  }
});

describe('#72 users.fof_discovery column', () => {
  it('exists on users table', async () => {
    const result = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'fof_discovery'`,
      [],
    );
    expect(result.rows.length).toBe(1);
  });
});

// ── #70 notification surface ─────────────────────────────────────────────────

describe('#70 notification lexicons', () => {
  const lexicons = [
    'net.openfederation.notification.list',
    'net.openfederation.notification.markRead',
    'net.openfederation.notification.unreadCount',
  ];
  for (const nsid of lexicons) {
    it(`${nsid}.json exists`, () => {
      expect(lexiconExists(nsid)).toBe(true);
    });
  }
});

describe('#70 notifications table', () => {
  it('exists with expected columns', async () => {
    const result = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'notifications' ORDER BY ordinal_position`,
      [],
    );
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('recipient_did');
    expect(cols).toContain('category');
    expect(cols).toContain('payload');
    expect(cols).toContain('created_at');
    expect(cols).toContain('read_at');
  });
});
