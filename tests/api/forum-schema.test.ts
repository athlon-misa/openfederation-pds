import { describe, it, expect } from 'vitest';
import { query } from '../../src/db/client.js';
import '../../src/server/index.js'; // triggers ensureSchema() on import

async function tableExists(name: string): Promise<boolean> {
  const res = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_name = $1
     ) AS exists`,
    [name]
  );
  return res.rows[0].exists;
}

describe('forum/events schema', () => {
  it('creates forum_threads, forum_posts, event_rsvps', async () => {
    expect(await tableExists('forum_threads')).toBe(true);
    expect(await tableExists('forum_posts')).toBe(true);
    expect(await tableExists('event_rsvps')).toBe(true);
  });
});
