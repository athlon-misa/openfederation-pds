/**
 * Stage demo, browser side. This page plays Elena's laptop: it runs the real
 * @open-federation/pseudonym code, so Night Desk's twelve words and key exist
 * only here. The demo server (run.ts) is used for setup, for reading the PDS
 * database and as the independent verifier.
 */
import {
  fetchTokenKeys, collectTokens, loginWithPhrase, signPresence, createRevealBundle,
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  type CreationToken, type RevealBundle,
} from '../../../packages/openfederation-pseudonym/src/index.js';

interface Config {
  pdsUrl: string; plcUrl: string; serviceDid: string; handleSuffix: string;
  elena: { did: string; handle: string; name: string; email: string; accessJwt: string };
  impostor: { did: string; name: string };
}
interface Saved {
  elenaDid: string;
  tokens: CreationToken[];
  spent: number;
  nd?: { did: string; handle: string; phrase: string };
  ndJwt?: string;
  published?: { uri: string; title: string; hash: string };
  bundle?: RevealBundle;
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

async function xrpc<T>(nsid: string, body: unknown, jwt?: string): Promise<T> {
  const res = await fetch(`${cfg!.pdsUrl}/xrpc/${nsid}`, {
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
  ($('btn-create') as HTMLButtonElement).disabled = !!nd || !saved?.tokens.length;
  document.querySelectorAll<HTMLElement>('#create-steps li').forEach((li) => { li.className = nd ? 'done' : ''; });
  if (!nd) return;
  const ol = $('phrase');
  ol.innerHTML = '';
  nd.phrase.split(' ').forEach((w) => { const li = document.createElement('li'); li.textContent = w; ol.appendChild(li); });
  $('nd-did').textContent = `${nd.handle} · ${nd.did}`;
  const words = $<HTMLTextAreaElement>('login-words');
  if (!words.value) words.value = nd.phrase;
}

function renderPublish(): void {
  const signedIn = !!saved?.ndJwt;
  $('login-state').textContent = signedIn ? `signed in as ${saved!.nd!.handle}` : 'signed out';
  $('editor').hidden = !signedIn || !!saved?.published;
  ($('btn-login') as HTMLButtonElement).disabled = signedIn || !saved?.nd;
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

function renderAll(): void {
  if (cfg) $('elena-handle').textContent = `${cfg.elena.handle} · investigative reporter`;
  renderTokens();
  renderPhrase();
  renderPublish();
  renderReveal();
}

// ---------- Actions ----------

function busy<T extends unknown[]>(btn: HTMLButtonElement, fn: (...a: T) => Promise<void>) {
  return async (...a: T) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(...a); } catch (err) {
      console.error(err);
      setStatus('failed', err instanceof Error ? err.message.slice(0, 90) : 'Something went wrong');
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
  const s = await loginWithPhrase({ pdsUrl: cfg!.pdsUrl, phrase, expectedServiceDid: cfg!.serviceDid });
  if (s.did !== saved?.nd?.did) throw new Error('Signed in to a different account');
  saved!.ndJwt = s.accessJwt;
  save();
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
$('btn-reset-yes').addEventListener('click', async () => {
  $('reset-confirm').hidden = true; $('btn-reset').hidden = false;
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
  setStatus('ready', 'Local server ready · offline');
  renderAll();
  if (screens[current].id === 'server') void lookInside();
}

function fromHash(): void {
  const i = screens.findIndex((s) => `#${s.id}` === location.hash);
  if (i >= 0 && i !== current) show(i);
}
window.addEventListener('hashchange', fromHash);
const start = screens.findIndex((s) => `#${s.id}` === location.hash);
show(start >= 0 ? start : 0);
void boot();
