/**
 * Mirror this PLC directory's DIDs into another directory, plc.directory by
 * default, so identities created here resolve across the whole AT Protocol
 * network (docs/PLC-MIRROR.md).
 *
 * One-way and append-only. For every DID that changed here (read from this
 * directory's /export stream), the operation log here is compared with the
 * target's (`GET /:did/log` on both, the current valid chain):
 *   - the target has none of it: every operation is submitted, genesis first;
 *   - the target has a prefix of it: the missing operations are submitted in
 *     order (PLC accepts an operation only when its `prev` is the target's
 *     current head, so order is the whole protocol);
 *   - the logs are equal: nothing to do;
 *   - they differ anywhere else (diverged): reported, never overwritten.
 * The operations are the ones the DID's rotation keys signed; nothing is
 * re-signed, so the target verifies each one exactly as this directory did.
 *
 * Run once:      node plc-server/mirror.js --source https://plc.openfederation.net [--target https://plc.directory] [--did did:plc:…] [--apply]
 * Run alongside: PLC_MIRROR_TARGETS=https://plc.directory on the PLC service (server.js)
 *
 * Without --apply nothing is sent: the run prints what it would submit.
 */

const DEFAULT_TARGET = 'https://plc.directory';
const EXPORT_PAGE = 1000;

function trimUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${u}: not an http(s) URL`);
  return url.toString().replace(/\/+$/, '');
}

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;

async function getJson(fetchFn, url) {
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

/** The current valid chain of signed operations, genesis first, or null. */
async function getLog(fetchFn, base, did) {
  return getJson(fetchFn, `${base}/${did}/log`);
}

/** Stable comparison of two operations (key order does not matter). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * What the target is missing for one DID.
 * @returns {{ status: 'missing'|'behind'|'same'|'diverged'|'absent', toSend: object[] }}
 */
function planDid(sourceLog, targetLog) {
  if (!sourceLog || sourceLog.length === 0) return { status: 'absent', toSend: [] };
  // A DID removed here (its last operation a tombstone) is not published to a
  // directory that has never seen it: that would put "created, then deleted"
  // into a permanent public log. One the target already has still gets the
  // tombstone, so it is deactivated there too.
  const last = sourceLog[sourceLog.length - 1];
  if (last && last.type === 'plc_tombstone' && (!targetLog || targetLog.length === 0)) {
    return { status: 'tombstoned', toSend: [] };
  }
  const target = targetLog ?? [];
  if (target.length > sourceLog.length) return { status: 'diverged', toSend: [] };
  for (let i = 0; i < target.length; i++) {
    if (canonical(target[i]) !== canonical(sourceLog[i])) return { status: 'diverged', toSend: [] };
  }
  if (target.length === sourceLog.length) return { status: 'same', toSend: [] };
  return { status: target.length === 0 ? 'missing' : 'behind', toSend: sourceLog.slice(target.length) };
}

/**
 * Bring one DID up to date in the target.
 * @returns {Promise<{ did: string, status: string, sent: number, error?: string }>}
 */
async function mirrorDid({ fetchFn = fetch, source, target, did, apply, delayMs = 0, log = () => {} }) {
  if (!DID_PLC.test(did)) return { did, status: 'skipped', sent: 0, error: 'not a did:plc' };
  const [sourceLog, targetLog] = await Promise.all([getLog(fetchFn, source, did), getLog(fetchFn, target, did)]);
  const plan = planDid(sourceLog, targetLog);
  if (plan.status === 'diverged') log(`DIVERGED ${did}: ${target} has a different history; left as it is`);
  if (plan.toSend.length === 0) return { did, status: plan.status, sent: 0 };
  if (!apply) {
    log(`would send ${plan.toSend.length} operation(s) for ${did} (${plan.status})`);
    return { did, status: plan.status, sent: 0 };
  }
  let sent = 0;
  for (const op of plan.toSend) {
    const res = await fetchFn(`${target}/${did}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(op),
    });
    if (!res.ok) {
      const error = `${res.status} ${await res.text().catch(() => '')}`.trim();
      log(`FAILED ${did} after ${sent} operation(s): ${error}`);
      return { did, status: plan.status, sent, error };
    }
    sent++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  log(`sent ${sent} operation(s) for ${did}`);
  return { did, status: plan.status, sent };
}

/**
 * DIDs changed in the source since `after` (an /export createdAt cursor), and
 * the cursor to continue from.
 */
async function changedDids({ fetchFn = fetch, source, after }) {
  const dids = new Set();
  let cursor = after ?? null;
  for (;;) {
    const url = `${source}/export?count=${EXPORT_PAGE}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetchFn(url, { headers: { accept: 'application/jsonlines' } });
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    const lines = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) break;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.did) dids.add(entry.did);
      if (entry.createdAt) cursor = entry.createdAt;
    }
    if (lines.length < EXPORT_PAGE) break;
  }
  return { dids: [...dids], cursor };
}

/**
 * One pass: every DID changed since `after`, brought up to date in `target`.
 * Returns a summary and the cursor to pass next time. A DID that failed keeps
 * the cursor from moving past it, so the next pass tries again.
 */
async function mirrorOnce({ fetchFn = fetch, source, target = DEFAULT_TARGET, after = null, dids = null, only = null, exclude = null, apply = false, delayMs = 0, log = () => {} }) {
  source = trimUrl(source);
  target = trimUrl(target);
  if (source === target) throw new Error('source and target are the same directory');
  const changed = dids ? { dids, cursor: after } : await changedDids({ fetchFn, source, after });
  const summary = { checked: 0, sent: 0, same: 0, skipped: 0, tombstoned: 0, diverged: [], failed: [], cursor: changed.cursor };
  // `only`: mirror nothing but these DIDs (an allowlist); `exclude`: never these.
  const onlySet = only ? new Set(only) : null;
  const excludeSet = new Set(exclude ?? []);
  for (const did of changed.dids) {
    if ((onlySet && !onlySet.has(did)) || excludeSet.has(did)) {
      summary.skipped++;
      continue;
    }
    summary.checked++;
    try {
      const r = await mirrorDid({ fetchFn, source, target, did, apply, delayMs, log });
      summary.sent += r.sent;
      if (r.status === 'same') summary.same++;
      if (r.status === 'tombstoned') summary.tombstoned++;
      if (r.status === 'diverged') summary.diverged.push(did);
      if (r.error) summary.failed.push({ did, error: r.error });
    } catch (err) {
      summary.failed.push({ did, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (summary.failed.length > 0) summary.cursor = after;
  return summary;
}

/**
 * Keep mirroring while the PLC service runs (server.js). Every `intervalMs`,
 * the DIDs changed since the last pass are mirrored to each target. The
 * first pass covers everything, so turning it on also backfills.
 */
function startMirror({ source, targets, intervalMs = 60_000, delayMs = 250, only = null, exclude = null, log = console.log }) {
  const cursors = new Map(targets.map((t) => [t, null]));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const target of targets) {
        const s = await mirrorOnce({ source, target, after: cursors.get(target), apply: true, delayMs, only, exclude, log: (m) => log(`[plc-mirror ${target}] ${m}`) });
        cursors.set(target, s.cursor);
        if (s.sent || s.failed.length || s.diverged.length) {
          log(`[plc-mirror ${target}] checked ${s.checked}, sent ${s.sent}, diverged ${s.diverged.length}, failed ${s.failed.length}`);
        }
      }
    } catch (err) {
      log(`[plc-mirror] pass failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(timer);
}

/** A comma-separated list of did:plc identifiers, or null when empty. Throws on anything else. */
function readDidList(raw, name) {
  const list = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const did of list) if (!DID_PLC.test(did)) throw new Error(`${name}: "${did}" is not a did:plc`);
  return list.length ? list : null;
}

/** PLC_MIRROR_TARGETS → list of target URLs (empty: off). Throws on an invalid entry. */
function readMirrorTargets(env) {
  const raw = (env.PLC_MIRROR_TARGETS || '').trim();
  if (!raw) return [];
  try {
    return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean).map(trimUrl))];
  } catch (err) {
    throw new Error(`PLC_MIRROR_TARGETS: ${err.message}`);
  }
}

module.exports = { planDid, mirrorDid, mirrorOnce, changedDids, startMirror, readMirrorTargets, readDidList, DEFAULT_TARGET };

// ── CLI ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const source = value('--source');
  if (!source || args.includes('--help')) {
    console.log('Usage: node plc-server/mirror.js --source <this directory> [--target https://plc.directory] [--did <did>]... [--only-dids-file <file>] [--exclude-dids-file <file>] [--apply] [--delay-ms 250]');
    process.exit(source ? 0 : 1);
  }
  const dids = args.flatMap((a, i) => (a === '--did' ? [args[i + 1]] : [])).filter(Boolean);
  const apply = args.includes('--apply');
  const fromFile = (name) => {
    const file = value(name);
    if (!file) return null;
    const text = require('fs').readFileSync(file, 'utf-8').split(/[\s,]+/).filter((l) => l && !l.startsWith('#')).join(',');
    return readDidList(text, name);
  };
  mirrorOnce({
    only: fromFile('--only-dids-file'),
    exclude: fromFile('--exclude-dids-file'),
    source,
    target: value('--target') || DEFAULT_TARGET,
    dids: dids.length ? dids : null,
    apply,
    delayMs: parseInt(value('--delay-ms') || '250', 10),
    log: (m) => console.log(m),
  }).then((s) => {
    console.log(`${apply ? '' : '(dry run) '}checked ${s.checked} DID(s): ${s.same} already there, ${s.sent} operation(s) sent, ${s.tombstoned} removed here (not published), ${s.skipped} skipped by the lists, ${s.diverged.length} diverged, ${s.failed.length} failed`);
    for (const f of s.failed) console.log(`  failed ${f.did}: ${f.error}`);
    if (!apply) console.log('Nothing was sent. Run again with --apply to submit.');
    process.exit(s.failed.length ? 1 : 0);
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
