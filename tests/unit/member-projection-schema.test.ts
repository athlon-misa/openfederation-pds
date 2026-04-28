/**
 * Schema-level RED/GREEN test for the member display projection (issue #66).
 * Doesn't require PLC — just checks the DB columns and projection function exist.
 */
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db/client.js';

describe('member display projection schema (issue #66)', () => {
  it('members_unique has a display_name column', async () => {
    const res = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'members_unique' AND column_name = 'display_name'`
    );
    expect(res.rows.length).toBe(1);
  });

  it('members_unique has an avatar_url column', async () => {
    const res = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'members_unique' AND column_name = 'avatar_url'`
    );
    expect(res.rows.length).toBe(1);
  });

  it('members_unique has a role column for the projection', async () => {
    const res = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'members_unique' AND column_name = 'role'`
    );
    expect(res.rows.length).toBe(1);
  });

  it('community_attestation_index table exists', async () => {
    const res = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'community_attestation_index'`
    );
    expect(res.rows.length).toBe(1);
  });

  it('community_attestation_index has subject_display_name column', async () => {
    const res = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'community_attestation_index' AND column_name = 'subject_display_name'`
    );
    expect(res.rows.length).toBe(1);
  });

  it('resolveDisplayFields is exported from display-projection module', async () => {
    const mod = await import('../../src/community/display-projection.js');
    expect(typeof mod.resolveDisplayFields).toBe('function');
  });
});
