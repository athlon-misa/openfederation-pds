/**
 * Discord import (#86): the export parser, the mapper and the record keys.
 * Pure: no database, no server.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readExportDir, parseExportJson, mapExport, parseMembersCsv, truncateBytes, DiscordExportError,
} from '../../cli/discord-export.js';
import {
  planBatches, newCheckpoint, invitesCsv, csvField, saveCheckpoint, loadCheckpoint, assertCheckpointMatches,
} from '../../cli/discord-import.js';
import { snowflakeRkey, snowflakeFromRkey, parseImportBatch, ImportBatchError } from '../../src/forum/import.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'discord');
const GENERAL = 'Riverside Book Club - Text Channels - general [1100000000000000010].json';

function exportFile(overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}): string {
  return JSON.stringify({
    guild: { id: '1000000000000000001', name: 'G' },
    channel: { id: '1100000000000000099', type: 'GuildTextChat', name: 'test' },
    messages: [{
      id: '1200000000000000999', type: 'Default', timestamp: '2026-01-01T00:00:00.000+00:00',
      timestampEdited: null, content: 'hello',
      author: { id: '1000000000000000777', name: 'someone', nickname: null, isBot: false },
      attachments: [], mentions: [], ...message,
    }],
    ...overrides,
  });
}

describe('Discord export parser', () => {
  it('reads the fixture: one server, four channels in id order', () => {
    const channels = readExportDir(FIXTURE);
    expect(channels.map((c) => c.name)).toEqual(['general', 'events', 'Dune discussion', 'organisers only']);
    expect(new Set(channels.map((c) => c.guildId))).toEqual(new Set(['1000000000000000001']));
    const general = channels[0];
    expect(general.messages).toHaveLength(8);
    expect(general.messages[1].editedAt).toBe('2026-01-05T18:07:30.000Z');
    expect(general.messages[2].replyTo).toBe('1200000000000000002');
    expect(general.messages[6].attachmentCount).toBe(1);
    expect(channels[2].isThread).toBe(true);
    expect(channels[2].category).toBe('general');
  });

  it('refuses what is not an export, with the file and the reason', () => {
    expect(() => parseExportJson('not json', 'x.json')).toThrow(/x\.json: not valid JSON/);
    expect(() => parseExportJson('{"messages": []}', 'x.json')).toThrow(/guild is missing/);
    expect(() => parseExportJson(exportFile({}, { id: 'abc' }), 'x.json')).toThrow(/messages\[0\]\.id is not a Discord id/);
    expect(() => parseExportJson(exportFile({}, { timestamp: 'yesterday' }), 'x.json')).toThrow(/timestamp/);
    expect(() => parseExportJson(exportFile({}, { content: 'x'.repeat(10_001) }), 'x.json')).toThrow(/longer than/);
    expect(() => parseExportJson(exportFile({}, { author: 'bob' }), 'x.json')).toThrow(/author is missing/);
    expect(() => parseExportJson(exportFile({}, { attachments: new Array(101).fill({}) }), 'x.json')).toThrow(/attachments/);
    expect(() => parseExportJson(exportFile({}, { reference: { messageId: '12; DROP' } }), 'x.json')).toThrow(/reference/);
  });

  it('refuses a direct-message export outright', () => {
    const dm = exportFile({ channel: { id: '1100000000000000099', type: 'DirectTextChat', name: 'dm' } });
    expect(() => parseExportJson(dm, 'dm.json')).toThrow(/direct-message/);
  });

  it('refuses ids beyond 63 bits and a message listed twice', () => {
    expect(() => parseExportJson(exportFile({}, { id: '99999999999999999999' }), 'x.json')).toThrow(DiscordExportError);
    const doc = JSON.parse(exportFile());
    doc.messages.push(doc.messages[0]);
    expect(() => parseExportJson(JSON.stringify(doc), 'x.json')).toThrow(/twice/);
  });

  it('refuses a directory mixing two servers, or a channel exported twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofc-discord-'));
    writeFileSync(join(dir, 'a.json'), exportFile());
    writeFileSync(join(dir, 'b.json'), exportFile({ guild: { id: '1000000000000000002', name: 'Other' }, channel: { id: '1100000000000000098', type: 'GuildTextChat', name: 'x' } }));
    expect(() => readExportDir(dir)).toThrow(/different server/);
    const dir2 = mkdtempSync(join(tmpdir(), 'ofc-discord-'));
    writeFileSync(join(dir2, 'a.json'), exportFile());
    writeFileSync(join(dir2, 'b.json'), exportFile());
    expect(() => readExportDir(dir2)).toThrow(/also exported/);
  });

  it('reads a member CSV with a header and quoted names', () => {
    const members = parseMembersCsv(readFileSync(join(FIXTURE, 'members.csv'), 'utf-8'));
    expect(members).toHaveLength(5);
    expect(members[4]).toEqual({ id: '1000000000000000105', name: 'Eve, the quiet one' });
    expect(() => parseMembersCsv('id,name\nnot-an-id,x\n')).toThrow(/row 1/);
  });
});

describe('mapping an export to threads and posts', () => {
  const channels = readExportDir(FIXTURE);

  it('makes channels and threads into forum threads, messages into posts, in order', () => {
    const plan = mapExport(channels);
    expect(plan.threads.map((t) => [t.title, t.tags, t.posts.length])).toEqual([
      ['#general', ['discord', 'Text Channels'], 5],
      ['#events', ['discord', 'Text Channels'], 2],
      ['Dune discussion', ['discord', '#general'], 3],
    ]);
    expect(plan.report).toMatchObject({
      channels: 2, discordThreads: 1, threads: 3, posts: 10, replies: 3, edited: 1, attachments: 1, authors: 3,
      skipped: { botMessages: 1, systemMessages: 2, emptyMessages: 0, privateThreads: 1, emptyChannels: 0 },
    });
    const general = plan.threads[0];
    expect(general.createdAt).toBe('2026-01-05T18:00:00.000Z');
    expect(general.posts.map((p) => p.createdAt)).toEqual([...general.posts.map((p) => p.createdAt)].sort());
  });

  it('skips bots and system messages by default, and can include bots', () => {
    const plan = mapExport(channels);
    const texts = plan.threads.flatMap((t) => t.posts.map((p) => p.text));
    expect(texts.join('\n')).not.toMatch(/Daily reminder|Joined the server|Started a thread/);
    const withBots = mapExport(channels, { includeBots: true });
    expect(withBots.report.posts).toBe(11);
    expect(withBots.report.skipped.systemMessages).toBe(2);
  });

  it('pseudonymises authors by default, stably within an import', () => {
    const plan = mapExport(channels);
    const authors = plan.threads.flatMap((t) => t.posts.map((p) => p.author));
    expect(new Set(authors)).toEqual(new Set(['Discord member 1', 'Discord member 2', 'Discord member 3']));
    // Alice wrote first, everywhere she appears she is the same label.
    expect(plan.threads[0].posts[0].author).toBe('Discord member 1');
    expect(plan.threads[2].posts[0].author).toBe('Discord member 1');
    expect(plan.pseudonyms['1000000000000000101']).toBe('Discord member 1');
    // Running again gives the same plan.
    expect(mapExport(channels)).toEqual(plan);
  });

  it('keeps earlier labels and continues the numbering', () => {
    const plan = mapExport(channels, { pseudonyms: { '1000000000000000103': 'Discord member 7' } });
    expect(plan.pseudonyms['1000000000000000103']).toBe('Discord member 7');
    expect(plan.pseudonyms['1000000000000000101']).toBe('Discord member 8');
  });

  it('never puts names or Discord user ids in what is sent, unless names are kept', () => {
    const plan = mapExport(channels);
    const sent = JSON.stringify(planBatches(plan, 'did:plc:community', null).map((b) => b.body));
    for (const leak of ['Alice', 'alice.reads', 'Bobby', 'bob_reads', 'carol', '1000000000000000101', '1000000000000000103', 'cdn.discordapp.com', 'SIGNED-TOKEN']) {
      expect(sent).not.toContain(leak);
    }
    // Mentions are rewritten: the rendered "@Bobby" and the raw "<@id>".
    const all = plan.threads.flatMap((t) => t.posts);
    expect(all.find((p) => p.messageId === '1200000000000000003')!.text).toMatch(/^@Discord member 2 same here!/);
    expect(all.find((p) => p.messageId === '1200000000000000102')!.text).toBe('Count me in, @Discord member 3!');

    const named = mapExport(channels, { keepNames: true });
    expect(named.threads[0].posts[0].author).toBe('Alice');
    expect(named.threads[0].posts[2].text).toMatch(/^@Bobby same here!/);
    expect(JSON.stringify(named.threads)).not.toContain('1000000000000000101');
  });

  it('keeps reply links only to imported messages in the same channel', () => {
    const plan = mapExport(channels);
    const replies = plan.threads.flatMap((t) => t.posts.filter((p) => p.replyToMessageId).map((p) => [p.messageId, p.replyToMessageId]));
    expect(replies).toEqual([
      ['1200000000000000003', '1200000000000000002'],
      ['1200000000000000102', '1200000000000000101'],
      ['1200000000000000203', '1200000000000000201'],
    ]);
    // A reply to a bot's message (skipped) loses its link but is kept.
    const doc = JSON.parse(readFileSync(join(FIXTURE, GENERAL), 'utf-8'));
    doc.messages[7].type = 'Reply';
    doc.messages[7].reference = { messageId: '1200000000000000005' };
    const ch = parseExportJson(JSON.stringify(doc), GENERAL);
    const post = mapExport([ch]).threads[0].posts.find((p) => p.messageId === '1200000000000000008')!;
    expect(post.replyToMessageId).toBeUndefined();
  });

  it('counts attachments and never carries their links', () => {
    const plan = mapExport(channels);
    const photo = plan.threads[0].posts.find((p) => p.messageId === '1200000000000000007')!;
    expect(photo.attachmentCount).toBe(1);
    expect(JSON.stringify(photo)).not.toMatch(/meetup\.jpg|https:/);
  });

  it('keeps markdown, unicode and emoji as written', () => {
    const plan = mapExport(channels);
    const posts = plan.threads[0].posts;
    expect(posts[0].text).toBe('Welcome to the **Riverside Book Club** 📚! Introduce yourselves below.');
    expect(posts.find((p) => p.messageId === '1200000000000000008')!.text).toContain('```js\nconst pages = 412;');
    expect(posts.find((p) => p.messageId === '1200000000000000003')!.text).toContain('日本語のタイトル ✨🙂');
  });

  it('includes private threads only when asked', () => {
    expect(mapExport(channels, { includePrivateThreads: true }).report.threads).toBe(4);
  });

  it('shortens text over the record limit without splitting a character', () => {
    const { text, cut } = truncateBytes('日本'.repeat(3000), 10_000, '…');
    expect(cut).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(10_000);
    expect(text.endsWith('本…') || text.endsWith('日…')).toBe(true);
    // An 18-byte family emoji is one character: it fits whole or not at all.
    expect(truncateBytes('👨‍👩‍👧'.repeat(10), 20).text).toBe('👨‍👩‍👧');
    expect(truncateBytes('👨‍👩‍👧'.repeat(10), 17).text).toBe('');
  });
});

describe('record keys from Discord ids', () => {
  it('is deterministic, a valid TID, and reversible', () => {
    const id = '1200000000000000203';
    const rkey = snowflakeRkey(id);
    expect(rkey).toBe(snowflakeRkey(id));
    expect(rkey).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    expect(snowflakeFromRkey(rkey)).toBe(id);
    expect(snowflakeRkey('1200000000000000204')).not.toBe(rkey);
  });

  it('sorts in the same order as the ids', () => {
    const ids = ['175928847299117063', '1100000000000000010', '1200000000000000001', '1200000000000000002', '9223372036854775807'];
    const keys = ids.map(snowflakeRkey);
    expect([...keys].sort()).toEqual(keys);
  });

  it('refuses what is not a snowflake', () => {
    expect(() => snowflakeRkey('9223372036854775808')).toThrow();
    expect(() => snowflakeRkey('0')).toThrow();
    expect(() => snowflakeRkey('12a')).toThrow();
  });
});

describe('the PDS side: checking a batch', () => {
  const base = { community: 'did:plc:abc', platform: 'discord' };
  const post = { channelId: '1100000000000000010', messageId: '1200000000000000001', text: 'hi', createdAt: '2026-01-05T18:00:00.000+00:00' };

  it('accepts a well-formed batch and normalises times', () => {
    const batch = parseImportBatch({ ...base, posts: [post] });
    expect(batch.posts[0].createdAt).toBe('2026-01-05T18:00:00.000Z');
  });

  it('refuses malformed batches', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ ...base, platform: 'slack', posts: [post] }, /platform/],
      [{ ...base }, /empty/],
      [{ ...base, posts: [{ ...post, messageId: 'x' }] }, /messageId/],
      [{ ...base, posts: [{ ...post, createdAt: '5 Jan' }] }, /createdAt/],
      [{ ...base, posts: [{ ...post, text: 'x'.repeat(10_001) }] }, /text/],
      [{ ...base, posts: [{ ...post, author: 'é'.repeat(51) }] }, /author/],
      [{ ...base, posts: [{ ...post, uri: 'at://elsewhere' }] }, /not allowed/],
      [{ ...base, posts: [post, post] }, /twice/],
      [{ ...base, posts: [{ ...post, text: ' ' }] }, /neither text nor attachments/],
      [{ ...base, posts: new Array(101).fill(0).map((_, i) => ({ ...post, messageId: String(1200000000000000001n + BigInt(i)) })) }, /at most/],
      [{ ...base, threads: [{ channelId: '1100000000000000010', title: '', createdAt: post.createdAt }] }, /title/],
      [{ ...base, threads: [{ channelId: '1100000000000000010', title: 't', tags: new Array(21).fill('x'), createdAt: post.createdAt }] }, /tags/],
    ];
    for (const [body, why] of bad) {
      let caught: unknown;
      try { parseImportBatch(body); } catch (e) { caught = e; }
      expect(caught, JSON.stringify(body).slice(0, 80)).toBeInstanceOf(ImportBatchError);
      expect((caught as Error).message).toMatch(why);
    }
  });
});

describe('batches, checkpoint and the invite list', () => {
  const plan = mapExport(readExportDir(FIXTURE));

  it('sends each thread before its posts, one channel per batch', () => {
    const batches = planBatches(plan, 'did:plc:c', null);
    expect(batches).toHaveLength(3);
    expect(batches[0].body.threads![0].title).toBe('#general');
    expect(batches[0].body.posts).toHaveLength(5);
    for (const b of batches) expect(new Set(b.body.posts!.map((p) => p.channelId))).toEqual(new Set([b.channelId]));
  });

  it('skips what the checkpoint says is done', () => {
    const cp = newCheckpoint('did:plc:c', '1000000000000000001', false);
    cp.threadsDone = ['1100000000000000010', '1100000000000000020'];
    cp.postsDoneThrough = { '1100000000000000010': '1200000000000000003', '1100000000000000020': '1200000000000000102' };
    const batches = planBatches(plan, 'did:plc:c', cp);
    expect(batches.map((b) => [b.channelId, b.includesThread, b.body.posts!.map((p) => p.messageId)])).toEqual([
      ['1100000000000000010', false, ['1200000000000000007', '1200000000000000008']],
      ['1100000000000000030', true, ['1200000000000000201', '1200000000000000202', '1200000000000000203']],
    ]);
  });

  it('writes the checkpoint readable only by its owner, and refuses one from another import', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ofc-cp-')), 'cp.json');
    const cp = newCheckpoint('did:plc:c', '1000000000000000001', false);
    saveCheckpoint(path, cp);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadCheckpoint(path)!;
    expect(() => assertCheckpointMatches(loaded, 'did:plc:other', '1000000000000000001', false)).toThrow(/community/);
    expect(() => assertCheckpointMatches(loaded, 'did:plc:c', '1000000000000000001', true)).toThrow(/keep-names/);
  });

  it('writes a CSV that spreadsheets will not run', () => {
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    const csv = invitesCsv([{ discordUserId: '1', discordName: 'Eve, the quiet one', importedAs: '', code: 'abc-123' }], 'https://ui.example/register');
    expect(csv).toContain('"Eve, the quiet one"');
    expect(csv).toContain('"https://ui.example/register?invite=abc-123"');
  });
});
