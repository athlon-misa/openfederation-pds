/**
 * Stage demo, browser side. This page plays Elena's laptop: it runs the real
 * @open-federation/pseudonym code, so Night Desk's twelve words and key exist
 * only here. The demo server (run.ts) is used for setup, for reading the PDS
 * database and as the independent verifier.
 */
import {
  fetchTokenKeys, collectTokens, loginWithPhrase, signPresence, createRevealBundle,
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  moveAccount, rememberPhraseWithPasskey, unlockPhraseWithPasskey,
  type CreationToken, type RevealBundle, type RememberedPhrase, type MoveStep,
} from '../../../packages/openfederation-pseudonym/src/index.js';

interface Config {
  pdsUrl: string; pdsBUrl: string; plcUrl: string; serviceDid: string; pdsBServiceDid: string; handleSuffix: string;
  elena: { did: string; handle: string; name: string; email: string; accessJwt: string };
  impostor: { did: string; name: string };
  /** What this server has already been used for, possibly from another browser window. */
  used: { passesCollected: boolean; pseudonymExists: boolean };
}
interface Saved {
  elenaDid: string;
  tokens: CreationToken[];
  spent: number;
  nd?: { did: string; handle: string; phrase: string };
  ndJwt?: string;
  /** Night Desk's words, encrypted on this laptop and unlocked with a passkey (#251). */
  remembered?: RememberedPhrase;
  published?: { uri: string; title: string; hash: string };
  bundle?: RevealBundle;
  movedTo?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEY = 'night-desk-demo';

let cfg: Config | null = null;
let saved: Saved | null = null;

function load(): void {
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { saved = null; }
}
function save(): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* demo still works without it */ }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || `${path} failed (${res.status})`);
  return json as T;
}

/** Night Desk's home: the first server, or the one it moved to. */
function home(): string {
  return saved?.movedTo ?? cfg!.pdsUrl;
}

function homeServiceDid(): string {
  return saved?.movedTo ? cfg!.pdsBServiceDid : cfg!.serviceDid;
}

async function xrpc<T>(nsid: string, body: unknown, jwt?: string): Promise<T> {
  const res = await fetch(`${home()}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${(json as { message?: string }).message ?? ''}`);
  return json as T;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same derivation as the verifier in run.ts. */
function challengeForWord(word: string): Promise<string> {
  return sha256Hex(`OpenNewsrooms stage challenge\n${word.trim().toLowerCase()}`);
}

function short(did: string): string {
  return did.length > 24 ? `${did.slice(0, 14)}…${did.slice(-6)}` : did;
}

// ---------- Status and navigation ----------

function setStatus(kind: 'ready' | 'busy' | 'failed', text: string): void {
  const el = $('status');
  el.className = `status is-${kind}`;
  $('status-text').textContent = text;
}

const screens = Array.from(document.querySelectorAll<HTMLElement>('.screen'));
let current = 0;

function show(i: number): void {
  current = Math.max(0, Math.min(screens.length - 1, i));
  screens.forEach((s, j) => s.classList.toggle('is-on', j === current));
  document.querySelectorAll<HTMLButtonElement>('#progress button').forEach((b, j) => {
    if (j === current) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    b.classList.toggle('done', j < current);
  });
  history.replaceState(null, '', `#${screens[current].id}`);
  if (screens[current].id === 'server') void lookInside();
  if (screens[current].id === 'files') void showRepo();
}

screens.forEach((s, j) => {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = s.dataset.step || String(j);
  b.addEventListener('click', () => show(j));
  li.appendChild(b);
  $('progress').appendChild(li);
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(current + 1); }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(current - 1); }
});

// ---------- Render from saved state ----------

function renderTokens(): void {
  const grid = $('token-grid');
  grid.innerHTML = '';
  const have = saved?.tokens.length ?? 0;
  for (let i = 0; i < 20; i++) {
    const s = document.createElement('span');
    if (i < have) {
      s.className = i < (saved?.spent ?? 0) ? 'spent' : 'on';
      s.style.animationDelay = `${i * 35}ms`;
    }
    grid.appendChild(s);
  }
  ($('btn-collect') as HTMLButtonElement).disabled = have > 0;
  if (have > 0) {
    $('tokens-note').textContent = `${have - (saved?.spent ?? 0)} passes ready on Elena's laptop. The server only knows she collected this month's batch, like everyone else.`;
  }
}

function renderPhrase(): void {
  const nd = saved?.nd;
  $('phrase-box').hidden = !nd;
  const btn = $('btn-create') as HTMLButtonElement;
  btn.disabled = !!nd || !saved?.tokens.length;
  btn.textContent = nd ? 'Night Desk created' : 'Create Night Desk';
  $('create-note').textContent = nd || saved?.tokens.length ? '' : 'Collect this month\u2019s passes first (the Passes step).';
  document.querySelectorAll<HTMLElement>('#create-steps li').forEach((li) => { li.className = nd ? 'done' : ''; });
  if (!nd) return;
  const ol = $('phrase');
  ol.innerHTML = '';
  nd.phrase.split(' ').forEach((w) => { const li = document.createElement('li'); li.textContent = w; ol.appendChild(li); });
  $('nd-did').textContent = `${nd.handle} · ${nd.did}`;
  const words = $<HTMLTextAreaElement>('login-words');
  if (!words.value && !saved?.remembered) words.value = nd.phrase;
}

function renderPublish(): void {
  const signedIn = !!saved?.ndJwt;
  $('login-state').textContent = signedIn ? `signed in as ${saved!.nd!.handle}` : 'signed out';
  $('editor').hidden = !signedIn || !!saved?.published;
  ($('btn-login') as HTMLButtonElement).disabled = signedIn || !saved?.nd;
  renderDevice(signedIn);
  const p = saved?.published;
  $('published').hidden = !p;
  if (p) {
    $('published').innerHTML = '';
    const k = document.createElement('p'); k.className = 'kicker'; k.textContent = 'Published · by Night Desk';
    const h = document.createElement('h3'); h.textContent = p.title;
    const m = document.createElement('p'); m.className = 'meta';
    m.textContent = `Fingerprint ${p.hash.slice(0, 16)}… kept at ${p.uri}`;
    $('published').append(k, h, m);
  }
}

function renderDevice(signedIn: boolean): void {
  const remembered = !!saved?.remembered;
  $('device').hidden = !saved?.nd || (!signedIn && !remembered);
  $('btn-remember').hidden = remembered || !signedIn;
  $('btn-unlock').hidden = !remembered || signedIn;
  $('btn-signout').hidden = !signedIn;
  $('device-note').textContent = !remembered
    ? 'Keep the words locked on this laptop, so tomorrow is a touch instead of twelve words.'
    : signedIn
      ? 'Remembered. The words are stored here encrypted; only Touch ID on this laptop opens them.'
      : 'No words to type. Touch ID opens them on this laptop, then Night Desk signs in as before.';
}

function renderAll(): void {
  if (cfg) $('elena-handle').textContent = `${cfg.elena.handle} · investigative reporter`;
  renderTokens();
  renderPhrase();
  renderPublish();
  renderReveal();
  renderMove();
}

// ---------- Actions ----------

/** Shown when this server's state doesn't match this window, e.g. it was used in another window. */
function showStale(on: boolean): void {
  $('stale').hidden = !on;
}

function busy<T extends unknown[]>(btn: HTMLButtonElement, fn: (...a: T) => Promise<void>) {
  return async (...a: T) => {
    if (btn.disabled) return;
    if (!cfg) { setStatus('busy', 'The server is still starting. Try again in a moment.'); return; }
    btn.disabled = true;
    try { await fn(...a); } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      if (/AlreadyCollected|AlreadyExists|HandleNotAvailable|already (taken|exists|in use)|InvalidToken|TokenSpent/i.test(msg)) {
        showStale(true);
        setStatus('failed', 'This server was already used. Reset the demo.');
      } else {
        setStatus('failed', msg.slice(0, 90));
      }
      btn.disabled = false;
    }
  };
}

$('btn-collect').addEventListener('click', busy($('btn-collect') as HTMLButtonElement, async () => {
  const keys = await fetchTokenKeys(cfg!.pdsUrl);
  const tokens = await collectTokens({ pdsUrl: cfg!.pdsUrl, accessJwt: cfg!.elena.accessJwt, keys, count: 20 });
  saved = { elenaDid: cfg!.elena.did, tokens, spent: 0 };
  save();
  renderAll();
}));

$('btn-create').addEventListener('click', busy($('btn-create') as HTMLButtonElement, async () => {
  const step = (k: string, cls: string) => {
    const li = document.querySelector<HTMLElement>(`#create-steps li[data-k="${k}"]`);
    if (li) li.className = cls;
  };
  const pause = () => new Promise((r) => setTimeout(r, 450));
  const c = cfg!;
  const token = saved!.tokens[saved!.spent];
  const handle = `nightdesk${c.handleSuffix}`;

  step('keys', 'busy'); await pause();
  const phrase = generatePseudonymPhrase();
  const keys = derivePseudonymKeys(phrase);
  step('keys', 'done');

  step('plc', 'busy'); await pause();
  const res = await fetch(`${c.pdsUrl}/xrpc/com.atproto.server.reserveSigningKey`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!res.ok) throw new Error(`reserveSigningKey failed (${res.status})`);
  const { signingKey } = await res.json() as { signingKey: string };
  const signed = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: signingKey, handle,
    pdsEndpoint: c.pdsUrl, ownerDid: c.elena.did, commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(signed);
  const plc = await fetch(`${c.plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
  if (!plc.ok) { step('plc', 'fail'); throw new Error(`Directory refused: ${await plc.text()}`); }
  step('plc', 'done');

  step('account', 'busy'); await pause();
  // No Authorization header: the server must not learn who is creating this account.
  const created = await xrpc<{ did: string; handle: string }>('net.openfederation.pseudonym.createAccount', { did, token });
  if (created.did !== did) { step('account', 'fail'); throw new Error('Server created a different DID'); }
  step('account', 'done');

  saved!.spent += 1;
  saved!.nd = { did, handle: created.handle, phrase };
  save();
  renderAll();
}));

async function lookInside(): Promise<void> {
  if (!cfg) return;
  const btn = $('btn-look') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const q = saved?.nd ? `?pseudonym=${encodeURIComponent(saved.nd.did)}` : '';
    const view = await api<{
      accounts: { did: string; handle: string; email: string | null; kind: string; status: string; hasPassword: boolean; loginKey: string | null; auditEntries: number }[];
      search: { tables: number; bothRows: number };
      tokens: { batchesCollected: number; spent: number };
    }>(`/api/server-view${q}`);
    const grid = $('db-grid');
    grid.innerHTML = '';
    const order = [cfg.elena.did, saved?.nd?.did].filter(Boolean) as string[];
    for (const did of order) {
      const a = view.accounts.find((x) => x.did === did);
      if (!a) continue;
      const isNd = did === saved?.nd?.did;
      const card = document.createElement('article'); card.className = 'db-card';
      const lab = document.createElement('p'); lab.className = 'label'; lab.textContent = isNd ? 'users table · row 2' : 'users table · row 1';
      const h = document.createElement('h3'); h.textContent = isNd ? 'Night Desk' : cfg.elena.name;
      const dl = document.createElement('dl');
      const rows: [string, string | null, string?][] = [
        ['handle', a.handle],
        ['did', short(a.did)],
        ['email', a.email],
        ['password', a.hasPassword ? 'stored (scrambled)' : null],
        ['signs in with', a.loginKey ? 'its twelve words (never sent to the server)' : 'email and password'],
        ...(a.loginKey ? [['public key', short(a.loginKey)] as [string, string]] : []),
        ...(isNd ? [['owner', null] as [string, null]] : []),
        ['audit log', a.auditEntries ? `${a.auditEntries} ${a.auditEntries === 1 ? 'entry' : 'entries'}` : 'no entries', a.auditEntries ? undefined : 'none'],
      ];
      for (const [k, v, cls] of rows) {
        const dt = document.createElement('dt'); dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v ?? 'nothing recorded';
        if (v === null || cls === 'none') dd.className = 'none';
        dl.append(dt, dd);
      }
      card.append(lab, h, dl);
      grid.appendChild(card);
    }
    const verdict = $('db-verdict');
    verdict.hidden = !saved?.nd;
    if (saved?.nd) {
      verdict.innerHTML = '';
      const s = document.createElement('strong');
      s.textContent = view.search.bothRows === 0 ? 'Nothing here connects Night Desk to Elena.' : `${view.search.bothRows} rows mention both accounts.`;
      const d = document.createElement('span');
      d.textContent = `Searched all ${view.search.tables} tables, row by row. Passes: ${view.tokens.batchesCollected} monthly batch collected, ${view.tokens.spent} used, with no record of who used it.`;
      verdict.append(s, d);
    }
  } catch (err) {
    setStatus('failed', err instanceof Error ? err.message.slice(0, 90) : 'Could not read the server');
  } finally {
    btn.disabled = false;
  }
}
$('btn-look').addEventListener('click', () => { void lookInside(); });

$('btn-login').addEventListener('click', busy($('btn-login') as HTMLButtonElement, async () => {
  const phrase = $<HTMLTextAreaElement>('login-words').value.trim().toLowerCase().split(/\s+/).join(' ');
  const s = await loginWithPhrase({ pdsUrl: home(), phrase, expectedServiceDid: homeServiceDid() });
  if (s.did !== saved?.nd?.did) throw new Error('Signed in to a different account');
  saved!.ndJwt = s.accessJwt;
  save();
  renderPublish();
}));

function passkeyError(err: unknown): Error {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/PasskeyPrfUnsupported/.test(msg)) return new Error('This browser can\u2019t lock keys with a passkey. Use Chrome or Safari 18.');
  if (/NotAllowedError|PasskeyCancelled/.test(msg)) return new Error('Touch ID was cancelled. Try again.');
  return err instanceof Error ? err : new Error(msg);
}

$('btn-remember').addEventListener('click', busy($('btn-remember') as HTMLButtonElement, async () => {
  try {
    saved!.remembered = await rememberPhraseWithPasskey({
      phrase: saved!.nd!.phrase, rpName: 'Open Newsrooms stage demo', userName: 'Stage demo pseudonym',
    });
  } catch (err) { throw passkeyError(err); }
  save();
  setStatus('ready', 'Remembered on this laptop');
  renderPublish();
}));

$('btn-signout').addEventListener('click', () => {
  delete saved!.ndJwt;
  save();
  $<HTMLTextAreaElement>('login-words').value = '';
  renderPublish();
});

$('btn-unlock').addEventListener('click', busy($('btn-unlock') as HTMLButtonElement, async () => {
  let phrase: string;
  try { phrase = await unlockPhraseWithPasskey(saved!.remembered!); } catch (err) { throw passkeyError(err); }
  const s = await loginWithPhrase({ pdsUrl: home(), phrase, expectedServiceDid: homeServiceDid() });
  if (s.did !== saved?.nd?.did) throw new Error('Signed in to a different account');
  saved!.ndJwt = s.accessJwt;
  save();
  setStatus('ready', 'Signed in with Touch ID');
  renderPublish();
}));

$('btn-publish').addEventListener('click', busy($('btn-publish') as HTMLButtonElement, async () => {
  const title = $<HTMLInputElement>('article-title').value.trim();
  const body = $<HTMLTextAreaElement>('article-body').value.trim();
  const hash = await sha256Hex(`${title}\n\n${body}`);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const now = new Date().toISOString();
  const out = await xrpc<{ uri: string }>('com.atproto.repo.createRecord', {
    repo: saved!.nd!.did, collection: 'net.openfederation.authorship.claim',
    record: {
      $type: 'net.openfederation.authorship.claim', contentHash: hash, title,
      url: `https://opennewsrooms.demo/night-desk/${slug}`, publishedAt: now, createdAt: now,
    },
  }, saved!.ndJwt);
  saved!.published = { uri: out.uri, title, hash };
  save();
  renderAll();
}));

async function prove(asStranger: boolean): Promise<void> {
  const word = $<HTMLInputElement>('word').value;
  if (!word.trim()) { $('word').focus(); return; }
  const nd = saved?.nd;
  if (!nd) throw new Error('Create Night Desk first');
  const challenge = await challengeForWord(word);
  const phrase = asStranger ? generatePseudonymPhrase() : nd.phrase;
  const { signature } = signPresence({ phrase, pseudonymDid: nd.did, challenge });
  const r = await api<{ valid: boolean; directoryKey?: string; error?: string }>('/api/verify-presence', {
    pseudonymDid: nd.did, word, signature,
  });
  const v = $('verdict');
  v.hidden = false;
  v.className = `verdict ${r.valid ? 'is-valid' : 'is-invalid'}`;
  v.innerHTML = '';
  const s = document.createElement('strong'); s.textContent = r.valid ? 'VALID' : 'INVALID';
  const t = document.createElement('span');
  t.textContent = r.valid
    ? 'The person in front of you holds Night Desk’s twelve words.'
    : asStranger ? 'Different words make a different key. Nobody else can sign as Night Desk.' : 'The signature does not match Night Desk.';
  v.append(s, t);
  $('verdict-note').textContent = `The word “${word.trim()}” was signed ${asStranger ? "with a stranger’s twelve words" : "on Elena’s laptop"} and checked by a separate verifier against Night Desk’s key in the public directory${r.directoryKey ? ` (${short(r.directoryKey)})` : ''}.`;
}
$('btn-prove').addEventListener('click', busy($('btn-prove') as HTMLButtonElement, async () => {
  await prove(false); ($('btn-prove') as HTMLButtonElement).disabled = false;
}));
$('btn-stranger').addEventListener('click', busy($('btn-stranger') as HTMLButtonElement, async () => {
  await prove(true); ($('btn-stranger') as HTMLButtonElement).disabled = false;
}));
$('word').addEventListener('input', () => { $('verdict').hidden = true; $('verdict-note').textContent = ''; });

// ---------- Files: the repository as folders ----------

const FOLDER_NAMES: Record<string, [string, string]> = {
  'app.bsky.actor.profile': ['profile', 'Night Desk\u2019s public profile: its name and description.'],
  'net.openfederation.authorship.claim': ['articles', 'The fingerprint of a published article, with its headline and link. If the story is changed, the fingerprint stops matching.'],
  'net.openfederation.pseudonym.link': ['reveals', 'A public statement linking Night Desk to its owner.'],
};

interface RepoFile { folder: string; collection: string; name: string; value: unknown }

async function readRepo(base: string, did: string): Promise<RepoFile[]> {
  const get = async <T>(nsid: string, params: Record<string, string>): Promise<T> => {
    const res = await fetch(`${base}/xrpc/${nsid}?${new URLSearchParams(params)}`);
    if (!res.ok) throw new Error(`${nsid} failed (${res.status})`);
    return res.json() as Promise<T>;
  };
  const { collections } = await get<{ collections: string[] }>('com.atproto.repo.describeRepo', { repo: did });
  const files: RepoFile[] = [];
  for (const collection of collections) {
    const { records } = await get<{ records: { uri: string; value: unknown }[] }>('com.atproto.repo.listRecords', { repo: did, collection, limit: '50' });
    for (const rec of records) {
      files.push({ folder: FOLDER_NAMES[collection]?.[0] ?? collection.split('.').pop()!, collection, name: `${rec.uri.split('/').pop()}.json`, value: rec.value });
    }
  }
  return files;
}

function renderTree(ul: HTMLElement, root: string, files: RepoFile[], onOpen?: (f: RepoFile, row: HTMLElement) => void): void {
  ul.innerHTML = '';
  const top = document.createElement('li'); top.className = 'folder';
  const topRow = document.createElement('span'); topRow.className = 'row'; topRow.textContent = `${root}/`;
  const inner = document.createElement('ul');
  top.append(topRow, inner);
  ul.appendChild(top);
  const folders = [...new Set(files.map((f) => f.folder))];
  for (const folder of folders) {
    const li = document.createElement('li'); li.className = 'folder';
    const row = document.createElement('span'); row.className = 'row'; row.textContent = `${folder}/`;
    const sub = document.createElement('ul');
    for (const f of files.filter((x) => x.folder === folder)) {
      const fli = document.createElement('li'); fli.className = 'file';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'row'; b.textContent = f.name;
      if (onOpen) b.addEventListener('click', () => onOpen(f, b)); else b.disabled = true;
      fli.appendChild(b); sub.appendChild(fli);
    }
    li.append(row, sub); inner.appendChild(li);
  }
}

function openFile(f: RepoFile, row: HTMLElement): void {
  document.querySelectorAll('#tree .row[aria-current]').forEach((x) => x.removeAttribute('aria-current'));
  row.setAttribute('aria-current', 'true');
  const v = $('file-view'); v.innerHTML = '';
  const h = document.createElement('h4'); h.textContent = `${f.folder}/${f.name}`;
  const what = document.createElement('p'); what.className = 'note what'; what.textContent = FOLDER_NAMES[f.collection]?.[1] ?? '';
  const { $type: _t, ...rest } = f.value as Record<string, unknown>;
  const pre = document.createElement('pre'); pre.textContent = JSON.stringify(rest, null, 2);
  v.append(h, what, pre);
}

async function showRepo(): Promise<void> {
  if (!cfg || !saved?.nd) {
    $('tree').innerHTML = '';
    $('repo-count').textContent = '';
    $('file-view').innerHTML = '<p class="note">Create Night Desk first.</p>';
    return;
  }
  const base = home();
  try {
    const files = await readRepo(base, saved.nd.did);
    $('repo-where').textContent = `On ${saved.movedTo ? 'the new home' : 'the server'} · ${base.replace('http://', '')}`;
    $('repo-count').textContent = `${files.length} files`;
    renderTree($('tree'), 'night-desk', files, openFile);
    const first = files.find((f) => f.folder === 'articles') ?? files[0];
    const row = first && Array.from(document.querySelectorAll<HTMLElement>('#tree .file .row')).find((b) => b.textContent === first.name);
    if (first && row) openFile(first, row);
  } catch (err) {
    setStatus('failed', err instanceof Error ? err.message.slice(0, 90) : 'Could not read the files');
  }
}

let backup: Uint8Array | null = null;

async function downloadBackup(): Promise<Uint8Array> {
  const res = await fetch(`${home()}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(saved!.nd!.did)}`);
  if (!res.ok) throw new Error(`Backup failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

$('btn-backup').addEventListener('click', busy($('btn-backup') as HTMLButtonElement, async () => {
  if (!saved?.nd) throw new Error('Create Night Desk first');
  backup = await downloadBackup();
  const url = URL.createObjectURL(new Blob([backup as BlobPart], { type: 'application/vnd.ipld.car' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'night-desk-backup.car'; a.className = 'backup-link';
  a.textContent = `night-desk-backup.car \u00b7 ${(backup.length / 1024).toFixed(1)} KB`;
  a.click();
  const note = $('backup-note'); note.innerHTML = '';
  note.append('Saved ', a, '. Every folder and file is inside, each one signed.');
  ($('btn-backup') as HTMLButtonElement).disabled = false;
}));

// ---------- Move: to a newsroom's own server ----------

function renderMove(): void {
  if (!cfg) return;
  $('from-url').textContent = cfg.pdsUrl.replace('http://', '');
  $('to-url').textContent = cfg.pdsBUrl.replace('http://', '');
  const moved = !!saved?.movedTo;
  ($('btn-move') as HTMLButtonElement).disabled = moved || !saved?.nd;
  ($('btn-move') as HTMLButtonElement).textContent = moved ? 'Night Desk has moved' : 'Move Night Desk';
  if (moved) document.querySelectorAll<HTMLElement>('#move-steps li').forEach((li) => { li.className = 'done'; });
  $('moved').hidden = !moved;
}

/** The move's steps, as the checklist on the Move screen names them. */
const MOVE_ITEM: Record<MoveStep, string> = {
  open: 'open', export: 'copy', import: 'copy', check: 'check', point: 'point', activate: 'activate', retire: 'retire',
};

$('btn-move').addEventListener('click', busy($('btn-move') as HTMLButtonElement, async () => {
  const c = cfg!; const nd = saved!.nd!;
  const items = Array.from(document.querySelectorAll<HTMLElement>('#move-steps li'));
  items.forEach((li) => { li.className = ''; });
  let current = '';
  const pause = () => new Promise((res) => setTimeout(res, 450));
  const label = nd.handle.slice(0, -c.handleSuffix.length);

  try {
    // Night Desk's own words drive every step; neither server's operator is needed.
    const session = await moveAccount({
      oldPdsUrl: c.pdsUrl, oldServiceDid: c.serviceDid,
      newPdsUrl: c.pdsBUrl, newServiceDid: c.pdsBServiceDid,
      plcUrl: c.plcUrl, phrase: nd.phrase, did: nd.did, newHandle: `${label}${c.handleSuffix}`,
      onStep: async (s) => {
        const k = MOVE_ITEM[s];
        if (k === current) return;
        items.find((li) => li.dataset.k === current)?.classList.replace('busy', 'done');
        items.find((li) => li.dataset.k === k)?.classList.add('busy');
        current = k;
        await pause();
      },
    });
    await pause();
    items.find((li) => li.dataset.k === current)?.classList.replace('busy', 'done');
    saved!.movedTo = c.pdsBUrl;
    saved!.ndJwt = session.accessJwt;
  } catch (err) {
    items.find((li) => li.dataset.k === current)?.classList.replace('busy', 'fail');
    throw err;
  }

  const doc = await (await fetch(`${c.plcUrl}/${nd.did}`)).json() as { service?: { serviceEndpoint: string }[] };
  const endpoint = doc.service?.[0]?.serviceEndpoint ?? '';
  const files = await readRepo(c.pdsBUrl, nd.did);
  save();
  renderTree($('tree-b'), 'night-desk', files);
  $('moved-line').textContent = `The public directory now says: Night Desk lives at ${endpoint.replace('http://', '')}. ${files.length} files arrived intact, and Night Desk is signed in there.`;
  renderMove();
  renderPublish();
}));

async function restoreMoved(): Promise<void> {
  if (!cfg || !saved?.movedTo || !saved.nd) return;
  try {
    const files = await readRepo(saved.movedTo, saved.nd.did);
    renderTree($('tree-b'), 'night-desk', files);
    $('moved-line').textContent = `The public directory now says: Night Desk lives at ${saved.movedTo.replace('http://', '')}. ${files.length} files arrived intact.`;
  } catch { /* shown again after the next move */ }
}

// ---------- Reveal: Night Desk is Elena ----------

const CHECK_TEXT: [string[], string][] = [
  [['genesisHash', 'genesisSignature'], 'Night Desk\u2019s public entry is genuine and unchanged since day one'],
  [['pseudonymSignature'], 'Night Desk\u2019s twelve words signed the sentence'],
  [['commitment'], 'The sealed note, locked in when Night Desk was created, names this account'],
  [['ownerSignature', 'ownerKeyCurrent'], 'That account signed the same sentence'],
  [['statement'], 'The sentence names these two accounts'],
];

function renderReveal(): void {
  const has = !!saved?.bundle;
  $('proof-parts').classList.toggle('ready', has);
  $('reveal-state').textContent = has ? 'ready to hand over' : 'not made yet';
  ($('btn-reveal') as HTMLButtonElement).disabled = has || !saved?.nd;
  ($('btn-check') as HTMLButtonElement).disabled = !has;
  ($('btn-impostor') as HTMLButtonElement).disabled = !has;
}

async function checkProof(bundle: RevealBundle, claimant: string): Promise<void> {
  const r = await api<{ valid: boolean; checks: { name: string; ok: boolean }[] }>('/api/verify-reveal', { bundle });
  const ul = $('checks');
  ul.hidden = false;
  ul.innerHTML = '';
  for (const [names, text] of CHECK_TEXT) {
    const cs = r.checks.filter((c) => names.includes(c.name));
    if (!cs.length) continue;
    const li = document.createElement('li');
    li.className = cs.every((c) => c.ok) ? 'ok' : 'bad';
    li.textContent = text;
    ul.appendChild(li);
  }
  const v = $('reveal-verdict');
  v.hidden = false;
  v.className = `verdict ${r.valid ? 'is-valid' : 'is-invalid'}`;
  v.innerHTML = '';
  const s = document.createElement('strong'); s.textContent = r.valid ? 'VALID' : 'INVALID';
  const t = document.createElement('span');
  t.textContent = r.valid
    ? `Night Desk belongs to ${claimant}.`
    : `${claimant} copied Elena\u2019s proof and put his own name in it. Night Desk never signed that, and the sealed note doesn\u2019t name him.`;
  v.append(s, t);
}

$('btn-reveal').addEventListener('click', busy($('btn-reveal') as HTMLButtonElement, async () => {
  const c = cfg!;
  const nd = saved!.nd!;
  saved!.bundle = await createRevealBundle({
    pdsUrl: c.pdsUrl, plcUrl: c.plcUrl, phrase: nd.phrase, pseudonymDid: nd.did, ownerDid: c.elena.did, ownerAccessJwt: c.elena.accessJwt,
  });
  save();
  renderReveal();
}));
$('btn-check').addEventListener('click', busy($('btn-check') as HTMLButtonElement, async () => {
  await checkProof(saved!.bundle!, cfg!.elena.name);
  ($('btn-check') as HTMLButtonElement).disabled = false;
}));
$('btn-impostor').addEventListener('click', busy($('btn-impostor') as HTMLButtonElement, async () => {
  // Marko takes Elena's finished proof and swaps in his own account.
  const b = structuredClone(saved!.bundle!);
  const m = cfg!.impostor.did;
  b.statement = b.statement.replace(cfg!.elena.did, m);
  b.owner.did = m;
  await checkProof(b, cfg!.impostor.name);
  ($('btn-impostor') as HTMLButtonElement).disabled = false;
}));

// ---------- Reset ----------

$('btn-reset').addEventListener('click', () => { $('reset-confirm').hidden = false; $('btn-reset').hidden = true; });
$('btn-reset-no').addEventListener('click', () => { $('reset-confirm').hidden = true; $('btn-reset').hidden = false; });
$('btn-stale-reset').addEventListener('click', () => { $('btn-reset-yes').click(); });
$('btn-reset-yes').addEventListener('click', async () => {
  $('reset-confirm').hidden = true; $('btn-reset').hidden = false;
  showStale(false);
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  saved = null; cfg = null;
  $<HTMLTextAreaElement>('login-words').value = '';
  $<HTMLInputElement>('word').value = '';
  $('verdict').hidden = true; $('verdict-note').textContent = '';
  $('db-grid').innerHTML = ''; $('db-verdict').hidden = true;
  $('checks').hidden = true; $('reveal-verdict').hidden = true;
  await api('/api/reset', {});
  show(0);
  void boot();
});

// ---------- Boot ----------

async function boot(): Promise<void> {
  setStatus('busy', 'Starting the server…');
  for (;;) {
    try {
      const s = await api<{ state: string; error: string }>('/api/status');
      if (s.state === 'ready') break;
      if (s.state === 'failed') { setStatus('failed', `Server failed: ${s.error.slice(0, 80)}`); return; }
    } catch { /* demo server restarting */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  cfg = await api<Config>('/api/state');
  load();
  if (saved && saved.elenaDid !== cfg.elena.did) { saved = null; save(); }
  showStale((cfg.used.passesCollected && !saved?.tokens.length) || (cfg.used.pseudonymExists && !saved?.nd));
  setStatus('ready', 'Local server ready · offline');
  renderAll();
  if (screens[current].id === 'server') void lookInside();
  if (screens[current].id === 'files') void showRepo();
  void restoreMoved();
}

function fromHash(): void {
  const i = screens.findIndex((s) => `#${s.id}` === location.hash);
  if (i >= 0 && i !== current) show(i);
}
window.addEventListener('hashchange', fromHash);
const start = screens.findIndex((s) => `#${s.id}` === location.hash);
show(start >= 0 ? start : 0);
void boot();
