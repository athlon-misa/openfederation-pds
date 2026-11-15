/**
 * Import follow-ups (#403), the importer side: the Slack export reader and
 * mapper, names typed as plain text, local attachments (and that nothing is
 * ever fetched), and reading a zip. Pure: no database, no server.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, cpSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readSlackExport, mapSlackExport, slackText, parseDay, SlackExportError } from '../../cli/slack-export.js';
import { readExportDir, mapExport } from '../../cli/discord-export.js';
import { buildNameMatcher, replacePlainNames, NAME_STOPLIST } from '../../cli/import-names.js';
import { chooseAttachments, emptyAttachmentCounts, folderTree, zipTree } from '../../cli/import-files.js';
import { ZipArchive, ZipError, crc32, safeEntryName } from '../../cli/zip-reader.js';
import { planBatches, runImport, newCheckpoint, assertCheckpointMatches, invitesCsv, type ImportTransport, type ImportBatchBody } from '../../cli/discord-import.js';
import { parseImportBatch } from '../../src/forum/import.js';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

const SLACK = join(__dirname, '..', 'fixtures', 'slack');
const DISCORD_MEDIA = join(__dirname, '..', 'fixtures', 'discord-media');

/** A zip of `files` (stored, no compression), for tests. */
function buildZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function filesUnder(dir: string, prefix: string): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ name: `${prefix}${relative(dir, p).split('\\').join('/')}`, data: readFileSync(p) });
    }
  };
  walk(dir);
  return out;
}

function memoryTransport(): ImportTransport & { batches: ImportBatchBody[]; uploads: Array<{ community: string; size: number; type: string }> } {
  const t = {
    batches: [] as ImportBatchBody[],
    uploads: [] as Array<{ community: string; size: number; type: string }>,
    async importBatch(body: ImportBatchBody) {
      t.batches.push(JSON.parse(JSON.stringify(body)));
      return { threads: { created: body.threads?.length ?? 0, existing: 0 }, posts: { created: body.posts?.length ?? 0, existing: 0 } };
    },
    async uploadBlob(community: string, data: Buffer, mimeType: string) {
      t.uploads.push({ community, size: data.length, type: mimeType });
      const cid = CID.create(1, 0x55, await sha256.digest(data)).toString();
      return { $type: 'blob' as const, ref: { $link: cid }, mimeType, size: data.length };
    },
    async createInvites(count: number) { return Array.from({ length: count }, (_, i) => `code-${i}`); },
  };
  return t;
}

const checkpointPath = () => join(mkdtempSync(join(tmpdir(), 'ofc-403-')), 'checkpoint.json');

// ── Slack ────────────────────────────────────────────────────────────

describe('Slack export reader', () => {
  it('reads users, channels and day files; skips private channels and never reads direct messages', () => {
    const exp = readSlackExport(SLACK);
    try {
      expect(exp.teamId).toBe('T0HARBOUR1');
      expect(exp.channels.map((c) => c.name)).toEqual(['general', 'patterns']);
      expect(exp.privateChannelsSkipped).toBe(1);
      expect(exp.directMessages).toBe(2);
      const general = exp.channels[0];
      expect(general.days).toBe(2);
      expect(general.duplicates).toBe(1);
      // Oldest first across day files.
      const ts = general.messages.map((m) => m.ts);
      expect([...ts].sort()).toEqual(ts);
      expect(JSON.stringify(exp.channels)).not.toContain('A direct message');
    } finally {
      exp.tree.close();
    }
  });

  it('reads private channels only when asked', () => {
    const exp = readSlackExport(SLACK, { includePrivateChannels: true });
    try {
      expect(exp.channels.map((c) => c.name)).toEqual(['general', 'patterns', 'organisers']);
    } finally {
      exp.tree.close();
    }
  });

  it('refuses what is not an export, with the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-bad-'));
    expect(() => readSlackExport(dir)).toThrow(/channels\.json/);
    writeFileSync(join(dir, 'channels.json'), '[{"id":"C0AAA1","name":"x/../../y"}]');
    writeFileSync(join(dir, 'users.json'), '[]');
    expect(() => readSlackExport(dir)).toThrow(/not a channel name/);
    writeFileSync(join(dir, 'channels.json'), 'nope');
    expect(() => readSlackExport(dir)).toThrow(/not valid JSON/);
    expect(() => parseDay([{ type: 'message', ts: 'yesterday' }], 'd.json')).toThrow(SlackExportError);
    expect(() => parseDay([{ type: 'message', ts: '1767603600.000100', text: 'x'.repeat(50_001) }], 'd.json')).toThrow(/longer than/);
    expect(() => parseDay({}, 'd.json')).toThrow(/not a list/);
  });
});

describe('Slack mapping', () => {
  const plan = () => {
    const exp = readSlackExport(SLACK);
    try {
      return mapSlackExport(exp);
    } finally {
      exp.tree.close();
    }
  };

  it('makes channels into forum threads and messages into posts; thread replies keep their parent', () => {
    const p = plan();
    expect(p.platform).toBe('slack');
    expect(p.threads.map((t) => [t.channelId, t.title, t.tags])).toEqual([
      ['C0GENERAL1', '#general', ['slack']], ['C0PATTERN1', '#patterns', ['slack']],
    ]);
    expect(p.report).toMatchObject({
      platform: 'slack', channels: 2, threads: 2, posts: 8, replies: 2, sourceThreads: 1, edited: 1, attachments: 4, authors: 4,
      skipped: {
        botMessages: 2, systemMessages: 2, emptyMessages: 1, deletedMessages: 1, duplicateMessages: 1,
        privateChannels: 1, directMessages: 2, emptyChannels: 0,
      },
      attachmentFiles: { linked: 1, unsupported: 1, remoteOnly: 1, deleted: 1, missing: 0, tooLarge: 0, overLimit: 0 },
    });
    const general = p.threads[0].posts;
    expect(general.map((x) => x.messageId)).toEqual([
      '1767603600.000100', '1767603720.000300', '1767603780.000400', '1767603840.000500',
      '1767690000.000100', '1767690120.000300', '1767690240.000500',
    ]);
    expect(general[2]).toMatchObject({ replyToMessageId: '1767603720.000300', editedAt: '2026-01-05T09:03:20.000Z' });
    expect(general[3].replyToMessageId).toBe('1767603720.000300');
    // Its parent was deleted on Slack: a top-level post.
    expect(general[5].replyToMessageId).toBeUndefined();
    expect(general[0].createdAt).toBe('2026-01-05T09:00:00.000Z');
  });

  it('pseudonymises authors and mentions, rewrites channel links, links and entities', () => {
    const general = plan().threads[0].posts;
    expect(general[0]).toMatchObject({ author: 'Slack member 1', text: 'Welcome to the circle! @Slack member 2 has the wool list.' });
    expect(general[2].text).toBe('On it & see #patterns <3');
    expect(general[3].text).toBe('Me too needle guide (https://example.org/needles)');
    expect(general[6].text).toBe('_waves_');
    expect(plan().threads[1].posts[0].text).toBe('@channel new pattern drop, mail circle@example.org');
  });

  it('replaces names typed as plain text, skipping common words, and reports them', () => {
    const p = plan();
    expect(p.threads[0].posts[1].text).toBe('Thanks Slack member 1! Slack member 3, bring needles. Will you come too, Slack member 4?');
    expect(p.namesReplaced).toEqual([
      { name: 'Juno', as: 'Slack member 3', count: 1 },
      { name: 'Ottilie', as: 'Slack member 1', count: 1 },
      { name: 'Will Hartley', as: 'Slack member 4', count: 1 },
    ]);
    expect(p.report.namesReplaced).toBe(3);
    const exp = readSlackExport(SLACK);
    try {
      const off = mapSlackExport(exp, { plainNames: false });
      expect(off.threads[0].posts[1].text).toBe('Thanks Ottilie! Juno, bring needles. Will you come too, Will Hartley?');
      expect(off.namesReplaced).toEqual([]);
    } finally {
      exp.tree.close();
    }
  });

  it('keeps names only when asked', () => {
    const exp = readSlackExport(SLACK);
    try {
      const kept = mapSlackExport(exp, { keepNames: true });
      expect(kept.threads[0].posts[0]).toMatchObject({ author: 'Ottilie', text: 'Welcome to the circle! @Kasimir Fenn has the wool list.' });
      expect(kept.pseudonyms).toEqual({});
    } finally {
      exp.tree.close();
    }
  });

  it('is deterministic, and reuses the labels of an earlier run', () => {
    const a = plan();
    expect(JSON.stringify(plan())).toBe(JSON.stringify(a));
    const exp = readSlackExport(SLACK);
    try {
      const later = mapSlackExport(exp, { pseudonyms: { U0AAAA0003: 'Slack member 9' } });
      expect(later.pseudonyms.U0AAAA0003).toBe('Slack member 9');
      expect(later.pseudonyms.U0AAAA0001).toBe('Slack member 10');
    } finally {
      exp.tree.close();
    }
  });

  it('sends nothing that names a Slack account: no user ids, no names, no file links', async () => {
    const t = memoryTransport();
    const p = plan();
    await runImport(p, newCheckpoint('did:plc:test', 'T0HARBOUR1', false, 'slack'), t, { checkpointPath: checkpointPath() });
    const sent = JSON.stringify(t.batches);
    for (const secret of ['U0AAAA', 'Ottilie', 'Bramblewood', 'Kasimir', 'Juno', 'Hartley', 'files.slack.com', 'xoxe', 'cover.png']) {
      expect(sent).not.toContain(secret);
    }
    // Every batch is what the PDS accepts.
    for (const b of t.batches) expect(() => parseImportBatch(b)).not.toThrow();
    expect(t.batches.every((b) => b.platform === 'slack')).toBe(true);
    expect(t.uploads).toEqual([{ community: 'did:plc:test', size: 70, type: 'image/png' }]);
    const withEmbed = t.batches.flatMap((b) => b.posts ?? []).find((x) => x.embeds);
    expect(withEmbed).toMatchObject({ messageId: '1767690000.000100', attachmentCount: 4, embeds: [{ mimeType: 'image/png', size: 70 }] });
  });

  it('batches resume after the checkpoint by Slack timestamp order', async () => {
    const p = plan();
    const cp = newCheckpoint('did:plc:test', 'T0HARBOUR1', false, 'slack');
    cp.threadsDone = ['C0GENERAL1'];
    cp.postsDoneThrough = { C0GENERAL1: '1767603840.000500' };
    const batches = planBatches(p, 'did:plc:test', cp);
    expect(batches[0].body.posts!.map((x) => x.messageId)).toEqual(['1767690000.000100', '1767690120.000300', '1767690240.000500']);
    expect(batches[0].body.threads).toBeUndefined();
    // A local file is never in what is sent.
    expect(JSON.stringify(batches[0].body)).not.toContain('attachments');
    expect(batches[0].uploads).toHaveLength(1);
  });

  it('a checkpoint from another platform or workspace is refused', () => {
    const cp = newCheckpoint('did:plc:test', 'T0HARBOUR1', false, 'slack');
    expect(() => assertCheckpointMatches(cp, 'did:plc:test', 'T0HARBOUR1', false, 'discord')).toThrow(/slack import/);
    expect(() => assertCheckpointMatches(cp, 'did:plc:test', 'T0OTHER001', false, 'slack')).toThrow(/Slack workspace/);
    expect(() => assertCheckpointMatches(cp, 'did:plc:test', 'T0HARBOUR1', false, 'slack')).not.toThrow();
  });

  it('the invite CSV names the platform', () => {
    const csv = invitesCsv([{ discordUserId: 'U0AAAA0001', discordName: 'Ottilie', importedAs: 'Slack member 1', code: 'abc' }], 'https://x/register', 'slack');
    expect(csv.split('\n')[0]).toBe('slack_user_id,slack_name,imported_as,invite_code,invite_link');
  });

  it('slackText leaves unknown markup alone and keeps unknown people anonymous', () => {
    const mention = (id: string) => (id === 'U0AAAA0001' ? '@A' : '@someone');
    const channel = () => '#channel';
    expect(slackText('<@U0ZZZZ9999|stranger> hi', mention, channel)).toBe('@someone hi');
    expect(slackText('<#C0SECRET1|secret-plans>', mention, channel)).toBe('#channel');
    expect(slackText('<!subteam^S0TEAM|@knitters> and <!here>', mention, channel)).toBe('@knitters and @here');
    expect(slackText('a <b c> d', mention, channel)).toBe('a <b c> d');
    expect(slackText('<https://example.org>', mention, channel)).toBe('https://example.org');
  });
});

describe('Slack export as a zip', () => {
  it('reads the same export from a zip as from its folder, files included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-zip-'));
    const zip = join(dir, 'Harbour Knitting Circle Slack export.zip');
    writeFileSync(zip, buildZip(filesUnder(SLACK, 'Harbour Knitting Circle Slack export/')));
    const fromZip = readSlackExport(zip);
    const fromDir = readSlackExport(SLACK);
    try {
      const a = mapSlackExport(fromZip);
      const b = mapSlackExport(fromDir);
      const strip = (p: typeof a) => JSON.stringify(p.threads.map((t) => t.posts.map(({ attachments, ...rest }) => [rest, attachments?.length ?? 0])));
      expect(strip(a)).toBe(strip(b));
      expect(a.report.attachmentFiles.linked).toBe(1);
      const t = memoryTransport();
      await runImport(a, newCheckpoint('did:plc:test', a.report.guild.id, false, 'slack'), t, { checkpointPath: checkpointPath() });
      expect(t.uploads).toEqual([{ community: 'did:plc:test', size: 70, type: 'image/png' }]);
    } finally {
      fromZip.tree.close();
      fromDir.tree.close();
    }
  });

  it('refuses damaged archives and ignores entries that try to leave the export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-bad-'));
    writeFileSync(join(dir, 'not.zip'), 'hello');
    expect(() => ZipArchive.open(join(dir, 'not.zip'))).toThrow(ZipError);
    const tricky = buildZip([
      { name: '../escape.json', data: Buffer.from('[]') },
      { name: '/abs.json', data: Buffer.from('[]') },
      { name: 'ok/../../x.json', data: Buffer.from('[]') },
      { name: 'fine.json', data: Buffer.from('[1]') },
    ]);
    writeFileSync(join(dir, 'tricky.zip'), tricky);
    const z = ZipArchive.open(join(dir, 'tricky.zip'));
    expect([...z.entries.keys()]).toEqual(['fine.json']);
    expect(z.readEntry('fine.json').toString()).toBe('[1]');
    expect(() => z.readEntry('fine.json', 2)).toThrow(/larger than/);
    z.close();
    // A flipped byte fails the checksum.
    const bad = Buffer.from(buildZip([{ name: 'a.json', data: Buffer.from('[1,2,3]') }]));
    bad[30 + 'a.json'.length] ^= 0xff;
    writeFileSync(join(dir, 'bad.zip'), bad);
    const zb = ZipArchive.open(join(dir, 'bad.zip'));
    expect(() => zb.readEntry('a.json')).toThrow(/checksum/);
    zb.close();
    expect(safeEntryName('a/b.json')).toBe(true);
    expect(safeEntryName('a\\b.json')).toBe(false);
    expect(safeEntryName('C:/x')).toBe(false);
    const tree = zipTree(join(dir, 'tricky.zip'));
    expect(tree.list('')).toEqual(['fine.json']);
    tree.close();
  });
});

// ── Names typed as plain text ────────────────────────────────────────

describe('names typed as plain text', () => {
  const people = [
    { id: 'a', names: ['Alice Moreau', 'alice.reads'] },
    { id: 'b', names: ['Bo', 'bo_b'] },
    { id: 'c', names: ['Will Grant', 'Mark'] },
    { id: 'd', names: ['Alice Fontaine'] },
    { id: 'e', names: ['Zoë'] },
  ];
  const label = (id: string) => `Member ${id.toUpperCase()}`;

  it('replaces whole words only, ignoring case', () => {
    const m = buildNameMatcher(people);
    expect(replacePlainNames('ask alice.reads or ALICE MOREAU', m, label)).toBe('ask Member A or Member A');
    expect(replacePlainNames('Malice and alicefoo stay', m, label)).toBe('Malice and alicefoo stay');
    expect(replacePlainNames('Zoë said hi; zoë again', m, label)).toBe('Member E said hi; Member E again');
  });

  it('skips short names, common words and the importer\'s own words', () => {
    const m = buildNameMatcher(people);
    // "Bo" is too short; "Will" and "Mark" are words.
    expect(replacePlainNames('Bo will mark it. Will Grant agrees.', m, label)).toBe('Bo will mark it. Member C agrees.');
    expect(NAME_STOPLIST.has('member')).toBe(true);
    expect(buildNameMatcher([{ id: 'x', names: ['Discord member', '1234', 'The Admin'] }]).regex).toBeNull();
  });

  it('a first name two people share becomes "someone"', () => {
    const m = buildNameMatcher(people);
    expect(replacePlainNames('Alice brought tea', m, label)).toBe('someone brought tea');
    expect(replacePlainNames('Alice Fontaine brought tea', m, label)).toBe('Member D brought tea');
  });

  it('the Discord importer replaces them too, by default, with a report', () => {
    const plan = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA });
    const [first, second] = plan.threads[0].posts;
    expect(first.text).toBe('Stage plan for Friday attached. Discord member 2, can you check the risers?');
    // "Will" is a word; a name not in the export is left alone.
    expect(second.text).toBe('Will do, thanks Discord member 1! Persimmon can help too.');
    expect(plan.namesReplaced).toEqual([
      { name: 'hollis.v', as: 'Discord member 1', count: 1 },
      { name: 'Wren', as: 'Discord member 2', count: 1 },
    ]);
    const off = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA, plainNames: false });
    expect(off.threads[0].posts[0].text).toContain('Wren, can you');
  });
});

// ── Attachments ──────────────────────────────────────────────────────

describe('attachments from a local Discord export', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('links images found beside the export; counts the rest; never fetches a CDN link', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('no network in an import'); });
    vi.stubGlobal('fetch', fetchSpy);

    const plan = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA });
    expect(plan.report.attachments).toBe(11);
    expect(plan.report.attachmentFiles).toEqual({
      linked: 6, remoteOnly: 1, missing: 1, unsupported: 2, tooLarge: 0, overLimit: 1, deleted: 0, notUploaded: 0,
    });
    const [first, , third] = plan.threads[0].posts;
    expect(first.attachments!.map((a) => [a.fileName, a.mimeType])).toEqual([['stage-plan.png', 'image/png'], ['wave.gif', 'image/gif']]);
    expect(third.attachments).toHaveLength(4);

    const t = memoryTransport();
    const totals = await runImport(plan, newCheckpoint('did:plc:test', '1000000000000000500', false), t, { checkpointPath: checkpointPath() });
    expect(totals.attachments).toEqual({ uploaded: 6, skipped: 0 });
    expect(t.uploads.map((u) => u.type)).toEqual(['image/png', 'image/gif', 'image/png', 'image/png', 'image/png', 'image/png']);
    const sent = t.batches.flatMap((b) => b.posts ?? []);
    expect(sent[0].embeds).toHaveLength(2);
    expect(sent[0].attachmentCount).toBe(6);
    expect(JSON.stringify(t.batches)).not.toMatch(/cdn\.discordapp|SIGNED-TOKEN|_Files|passwd/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('without --media files, or with attachments turned off, nothing is uploaded', () => {
    const none = mapExport(readExportDir(DISCORD_MEDIA));
    expect(none.report.attachmentFiles.linked).toBe(0);
    expect(none.threads[0].posts.some((p) => p.attachments)).toBe(false);
    const off = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA, attachments: { enabled: false } });
    expect(off.report.attachmentFiles).toMatchObject({ linked: 0, notUploaded: 9 });
  });

  it('respects the size limit', () => {
    const plan = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA, attachments: { maxBytes: 50 } });
    expect(plan.report.attachmentFiles).toMatchObject({ linked: 1, tooLarge: 7, unsupported: 1 });
  });

  it('a file the PDS refuses is left out of the post, not the import', async () => {
    const plan = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA });
    const t = memoryTransport();
    t.uploadBlob = async () => { throw Object.assign(new Error('413'), { status: 413 }); };
    const totals = await runImport(plan, newCheckpoint('did:plc:test', '1000000000000000500', false), t, { checkpointPath: checkpointPath() });
    expect(totals.attachments).toEqual({ uploaded: 0, skipped: 6 });
    expect(t.batches.flatMap((b) => b.posts ?? []).some((p) => p.embeds)).toBe(false);
    expect(totals.posts.created).toBe(3);
  });

  it('a link inside the export folder leading out of it is not followed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-link-'));
    cpSync(DISCORD_MEDIA, dir, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'secret.png'), readFileSync(join(SLACK, 'general', 'attachments', 'F0FILE0001-cover.png')));
    mkdirSync(join(dir, 'linked'));
    symlinkSync(join(outside, 'secret.png'), join(dir, 'linked', 'secret.png'));
    symlinkSync(outside, join(dir, 'linkdir'));
    const tree = folderTree(dir);
    expect(tree.isFile('linked/secret.png')).toBe(false);
    expect(tree.isFile('linkdir/secret.png')).toBe(false);
    expect(tree.isFile('../' + relative(join(dir, '..'), join(outside, 'secret.png')))).toBe(false);
    const counts = emptyAttachmentCounts();
    expect(chooseAttachments([{ fileName: 'x', file: null, size: 10 }], counts)).toEqual([]);
    expect(counts.missing).toBe(1);
  });

  it('batches never carry the local files, and stay what the PDS accepts', () => {
    const plan = mapExport(readExportDir(DISCORD_MEDIA), { exportDir: DISCORD_MEDIA });
    for (const b of planBatches(plan, 'did:plc:test', null)) {
      expect(JSON.stringify(b.body)).not.toContain('"attachments"');
      expect(() => parseImportBatch(b.body)).not.toThrow();
    }
  });
});
