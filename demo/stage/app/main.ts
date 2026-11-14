/**
 * Stage demo, browser side. This page plays Elena's laptop: it runs the real
 * @open-federation/pseudonym code, so Night Desk's twelve words and key exist
 * only here. The demo server (run.ts) is used for setup, for showing what the
 * server (offline) or the public record (live) knows, and as the independent
 * verifier.
 */
import {
  fetchTokenKeys, collectTokens, loginWithPhrase, signPresence, createRevealBundle,
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  moveAccount, rememberPhraseWithPasskey, unlockPhraseWithPasskey, challengeForWord as wordChallenge,
  revealLinkFragment, presenceLinkFragment,
  type CreationToken, type RevealBundle, type RevealBundleV2, type RememberedPhrase, type MoveStep, type OwnerSigner,
} from '../../../packages/openfederation-pseudonym/src/index.js';
import { deriveCustodyKeys, signOwnerRaw } from '../../../packages/openfederation-sdk/src/custody/index.js';
import qrcode from 'qrcode-generator';

interface Check { id: string; label: string; ok: boolean | null; detail: string }
interface Config {
  /** offline: the stack on this laptop. live: two real servers and the public directory. */
  mode: 'offline' | 'live';
  /** Live rehearsal: Night Desk's words are kept on this laptop for `npm run demo -- --cleanup`. */
  rehearsal: boolean;
  checks: Check[];
  plcUrl: string;
  /** Server A, Night Desk's first home; pdsServiceUrl is the endpoint DID documents name for it. */
  pdsUrl: string; serviceDid: string; handleSuffix: string; pdsServiceUrl: string;
  /** Server B, the new home, with its own handle domain. */
  pdsBUrl: string; pdsBServiceDid: string; pdsBHandleSuffix: string;
  /** custody: who signs Elena's half of the reveal. custodial: her server; assisted/self: her own key. */
  elena: { did: string; handle: string; name: string; accessJwt: string; custody: 'custodial' | 'assisted' | 'self' };
  /** contrast: Marko can sign in, so his own pseudonym's (custodial) reveal can be shown. */
  impostor: { did: string; name: string; contrast: boolean };
  contrastName: string;
  /** Live only: the public verifier audience phones open from a QR code. */
  verifierUrl: string | null;
  /** The context the audience's word becomes a challenge with (same on /verify). */
  presenceContext: string;
  /** What this server has already been used for, possibly from another browser window (offline). */
  used: { passesCollected: boolean; pseudonymExists: boolean };
  /** Live: this month's passes, kept on this laptop across resets. */
  wallet: { epoch: string; tokens: CreationToken[]; spent: number } | null;
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

/** Same derivation as the verifier in run.ts and the /verify page. */
function challengeForWord(word: string): string {
  return wordChallenge(word, cfg!.presenceContext);
}

/** Does Elena hold her own key (assisted or self), so she signs her half of the reveal herself? */
function elenaSignsHerself(): boolean {
  return !!cfg && cfg.elena.custody !== 'custodial';
}

/**
 * A QR code that opens the public verifier with this proof in the link's
 * #fragment, so phones check it themselves. Live only: offline, phones
 * can't reach this laptop's servers.
 */
function showQr(boxId: string, fragment: string | null): void {
  const box = $(boxId);
  box.hidden = false;
  box.innerHTML = '';
  if (!cfg?.verifierUrl) {
    const p = document.createElement('p'); p.className = 'note';
    p.textContent = 'In the live demo, a code here lets everyone check this on their own phone. Offline, phones can\u2019t reach this laptop.';
    box.appendChild(p);
    return;
  }
  if (!fragment) { box.hidden = true; return; }
  const url = `${cfg.verifierUrl}#${fragment}`;
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  const fig = document.createElement('figure'); fig.className = 'qr-code';
  fig.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  fig.querySelector('svg')?.setAttribute('aria-label', 'QR code: check it on your phone');
  const cap = document.createElement('figcaption');
  const b = document.createElement('b'); b.textContent = 'Check it on your phone. ';
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = display(cfg.verifierUrl.split(/[?#]/)[0]);
  cap.append(b, 'Your phone asks the public directory, not this laptop: ', a);
  fig.appendChild(cap);
  box.appendChild(fig);
}

/** A server's address without the scheme, for the screen. */
function display(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** Elena's access token, fresh: the show can run longer than one token lasts. */
async function elenaJwt(): Promise<string> {
  return (await api<{ accessJwt: string }>('/api/elena-session')).accessJwt;
}

/** Live: keep the passes on this laptop (run.ts), so a reset or restart doesn't lose them. */
async function keepWallet(): Promise<void> {
  if (cfg?.mode !== 'live' || !saved?.tokens.length) return;
  await api('/api/wallet', { tokens: saved.tokens, spent: saved.spent });
  setLiveStatus();
}

/** Live header: which servers, pre-flight, passes left on this laptop. */
function setLiveStatus(): void {
  if (!cfg || cfg.mode !== 'live') return;
  const passes = saved?.tokens.length ? `${saved.tokens.length - saved.spent} passes` : 'passes not collected';
  setStatus('ready', `Live${cfg.rehearsal ? ' rehearsal' : ''} · ${display(cfg.pdsUrl)} → ${display(cfg.pdsBUrl)} · pre-flight green · ${passes}`);
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
      if (cfg.mode === 'live' && /AlreadyCollected/.test(msg)) {
        setStatus('failed', 'This account\u2019s passes for the month were collected elsewhere. Use a rehearsal account.');
      } else if (cfg.mode === 'offline' && /AlreadyCollected|AlreadyExists|HandleNotAvailable|already (taken|exists|in use)|InvalidToken|TokenSpent/i.test(msg)) {
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
  const tokens = await collectTokens({ pdsUrl: cfg!.pdsUrl, accessJwt: await elenaJwt(), keys, count: 20 });
  saved = { elenaDid: cfg!.elena.did, tokens, spent: 0 };
  save();
  await keepWallet();
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
  if (!token) throw new Error('No passes left this month');
  // Free on both servers ("nightdesk" unless an earlier run kept it): it goes into the public entry.
  const { label } = await api<{ label: string }>('/api/free-handle');
  const handle = `${label}${c.handleSuffix}`;

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
    pdsEndpoint: c.pdsServiceUrl, ownerDid: c.elena.did, commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(signed);
  // Live rehearsal: keep the words before the DID exists anywhere, so cleanup can always find it.
  if (c.rehearsal) await api('/api/rehearsal', { did, handle, phrase });
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
  await keepWallet();
  renderAll();
}));

interface DatabaseView {
  view: 'database';
  accounts: { did: string; handle: string; email: string | null; kind: string; status: string; hasPassword: boolean; loginKey: string | null; auditEntries: number }[];
  search: { tables: number; bothRows: number };
  tokens: { batchesCollected: number; spent: number };
}
interface PublicEntry { at: string; kind: 'create' | 'update' | 'tombstone'; handle?: string; endpoint?: string; rotationKeys?: number; sealedNote?: boolean }
interface PublicAccount {
  did: string; handle?: string; endpoint: string; entries: PublicEntry[];
  collections: { name: string; files: number }[]; namesOther: boolean;
}
interface PublicView {
  view: 'public';
  elena: PublicAccount; nightDesk: PublicAccount | null;
  search: { entries: number; files: number };
}

/** Which view the Server screen shows: the server's own database (offline) or the public record (live). */
function renderServerHead(kind: 'database' | 'public'): void {
  $('server-kind').textContent = kind === 'database'
    ? 'Database view · this laptop\u2019s server'
    : 'Public view · no database access';
  $('server-lede').textContent = kind === 'database'
    ? 'Straight from the server\u2019s database, not a slide.'
    : 'These are real servers, so we can\u2019t open their databases. This is what anyone can read, from their own phone: the public directory and the files.';
}

function card(label: string, title: string, rows: [string, string | null, string?][]): HTMLElement {
  const el = document.createElement('article'); el.className = 'db-card';
  const lab = document.createElement('p'); lab.className = 'label'; lab.textContent = label;
  const h = document.createElement('h3'); h.textContent = title;
  const dl = document.createElement('dl');
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v ?? 'nothing recorded';
    if (v === null || cls === 'none') dd.className = 'none';
    if (cls === 'hit') dd.className = 'hit';
    dl.append(dt, dd);
  }
  el.append(lab, h, dl);
  return el;
}

function entryLine(e: PublicEntry): string {
  const day = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
  if (e.kind === 'tombstone') return `${day} · retired`;
  return `${day} · ${e.kind === 'create' ? 'created on' : 'moved to'} ${display(e.endpoint ?? '?')}${e.handle ? ` as ${e.handle}` : ''}`;
}

function renderPublicView(view: PublicView): void {
  const grid = $('db-grid');
  grid.innerHTML = '';
  const people: [PublicAccount, boolean][] = [[view.elena, false], ...(view.nightDesk ? [[view.nightDesk, true] as [PublicAccount, boolean]] : [])];
  for (const [a, isNd] of people) {
    const files = a.collections.reduce((n, c) => n + c.files, 0);
    const last = a.entries[a.entries.length - 1];
    grid.appendChild(card(isNd ? 'public directory and files · Night Desk' : `public directory and files · ${cfg!.elena.name}`,
      isNd ? 'Night Desk' : cfg!.elena.name, [
        ['handle', a.handle ?? null],
        ['did', short(a.did)],
        ['lives at', a.endpoint ? display(a.endpoint) : null],
        ['directory', `${a.entries.length} ${a.entries.length === 1 ? 'entry' : 'entries'}`],
        ...a.entries.map((e, i) => [i === 0 ? 'history' : '', entryLine(e)] as [string, string]),
        ...(isNd ? [['sealed note', last?.sealedNote ? 'locked inside the entry; it names nobody you can read' : null] as [string, string | null]] : []),
        ['files', `${files} in ${a.collections.length} ${a.collections.length === 1 ? 'folder' : 'folders'}`],
        ['names the other', a.namesOther ? 'yes' : 'nothing', a.namesOther ? 'hit' : 'none'],
      ]));
  }
  const verdict = $('db-verdict');
  verdict.hidden = !view.nightDesk;
  if (view.nightDesk) {
    verdict.innerHTML = '';
    const bad = view.elena.namesOther || view.nightDesk.namesOther;
    const s = document.createElement('strong');
    s.textContent = bad ? 'The public record links the two accounts.' : 'Nothing in public connects Night Desk to Elena.';
    const d = document.createElement('span');
    d.textContent = `Read ${view.search.entries} directory entries and ${view.search.files} files, as anyone can: neither account names the other\u2019s DID or handle.`;
    if (bad) d.textContent = `Read ${view.search.entries} directory entries and ${view.search.files} files: one names the other.`;
    verdict.append(s, d);
  }
}

async function lookInside(): Promise<void> {
  if (!cfg) return;
  const btn = $('btn-look') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const q = saved?.nd ? `?pseudonym=${encodeURIComponent(saved.nd.did)}` : '';
    const result = await api<DatabaseView | PublicView>(`/api/server-view${q}`);
    renderServerHead(result.view);
    if (result.view === 'public') { renderPublicView(result); return; }
    const view = result;
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
  await setProfilePicture(saved!.nd!.did, saved!.ndJwt!);
  saved!.published = { uri: out.uri, title, hash };
  save();
  renderAll();
}));

/** A small moon on the night sky, as a PNG. */
function drawPicture(): Promise<Blob> {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#10131a'; g.fillRect(0, 0, 96, 96);
  g.fillStyle = '#f2efe6'; g.beginPath(); g.arc(50, 46, 24, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#10131a'; g.beginPath(); g.arc(61, 38, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f2efe6';
  for (const [x, y] of [[20, 20], [76, 70], [70, 18], [26, 74]]) g.fillRect(x, y, 2, 2);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'));
}

/** Night Desk's profile picture: a blob the profile file points to. It travels with a move (#264). */
async function setProfilePicture(did: string, jwt: string): Promise<void> {
  const base = home();
  const current = await fetch(`${base}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection: 'app.bsky.actor.profile', rkey: 'self' })}`);
  const profile = current.ok ? ((await current.json()) as { value: Record<string, unknown> }).value : {};
  if (profile.avatar) return;
  const up = await fetch(`${base}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${jwt}` }, body: await drawPicture(),
  });
  if (!up.ok) throw new Error(`uploadBlob failed (${up.status})`);
  const { blob } = await up.json() as { blob: unknown };
  await xrpc('com.atproto.repo.putRecord', {
    repo: did, collection: 'app.bsky.actor.profile', rkey: 'self',
    record: { ...profile, $type: 'app.bsky.actor.profile', avatar: blob },
  }, jwt);
}

async function prove(asStranger: boolean): Promise<void> {
  const word = $<HTMLInputElement>('word').value;
  if (!word.trim()) { $('word').focus(); return; }
  const nd = saved?.nd;
  if (!nd) throw new Error('Create Night Desk first');
  const challenge = challengeForWord(word);
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
  showQr('prove-qr', presenceLinkFragment({ pseudonymDid: nd.did, word, signature, context: cfg!.presenceContext }));
}
$('btn-prove').addEventListener('click', busy($('btn-prove') as HTMLButtonElement, async () => {
  await prove(false); ($('btn-prove') as HTMLButtonElement).disabled = false;
}));
$('btn-stranger').addEventListener('click', busy($('btn-stranger') as HTMLButtonElement, async () => {
  await prove(true); ($('btn-stranger') as HTMLButtonElement).disabled = false;
}));
$('word').addEventListener('input', () => { $('verdict').hidden = true; $('verdict-note').textContent = ''; $('prove-qr').hidden = true; });

// ---------- Files: the repository as folders ----------

const FOLDER_NAMES: Record<string, [string, string]> = {
  'app.bsky.actor.profile': ['profile', 'Night Desk\u2019s public profile: its name, description and picture. The picture itself is stored next to the files and goes wherever they go.'],
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
  v.append(h, what);
  const avatar = (rest.avatar as { ref?: { $link?: string } } | undefined)?.ref?.$link;
  if (avatar && saved?.nd) {
    const img = document.createElement('img'); img.className = 'file-picture'; img.alt = 'Night Desk\u2019s picture';
    img.src = `${home()}/xrpc/com.atproto.sync.getBlob?${new URLSearchParams({ did: saved.nd.did, cid: avatar })}`;
    v.appendChild(img);
  }
  v.appendChild(pre);
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
    $('repo-where').textContent = `On ${saved.movedTo ? 'the new home' : 'the server'} · ${display(base)}`;
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
  $('from-url').textContent = display(cfg.pdsUrl);
  $('to-url').textContent = display(cfg.pdsBUrl);
  const moved = !!saved?.movedTo;
  ($('btn-move') as HTMLButtonElement).disabled = moved || !saved?.nd;
  ($('btn-move') as HTMLButtonElement).textContent = moved ? 'Night Desk has moved' : 'Move Night Desk';
  if (moved) document.querySelectorAll<HTMLElement>('#move-steps li').forEach((li) => { li.className = 'done'; });
  $('moved').hidden = !moved;
}

/** The move's steps, as the checklist on the Move screen names them. */
const MOVE_ITEM: Record<MoveStep, string> = {
  open: 'open', export: 'copy', import: 'copy', blobs: 'copy', check: 'check', point: 'point', activate: 'activate', retire: 'retire',
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
      // A handle under the new server's own domain (describeServer availableUserDomains).
      plcUrl: c.plcUrl, phrase: nd.phrase, did: nd.did, newHandle: `${label}${c.pdsBHandleSuffix}`,
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

  // The public directory names the new home and the handle under its domain.
  const doc = await (await fetch(`${c.plcUrl}/${nd.did}`)).json() as { service?: { serviceEndpoint: string }[]; alsoKnownAs?: string[] };
  const endpoint = doc.service?.[0]?.serviceEndpoint ?? '';
  const newHandle = doc.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice(5);
  if (newHandle) saved!.nd = { ...nd, handle: newHandle };
  save();
  if (c.rehearsal) await api('/api/rehearsal', { did: nd.did, movedTo: c.pdsBUrl });
  const files = await readRepo(c.pdsBUrl, nd.did);
  renderTree($('tree-b'), 'night-desk', files);
  $('moved-line').textContent = `The public directory now says: Night Desk lives at ${display(endpoint)}, as ${saved!.nd!.handle}. ${files.length} files arrived intact, and Night Desk is signed in there.`;
  renderMove();
  renderPublish();
}));

async function restoreMoved(): Promise<void> {
  if (!cfg || !saved?.movedTo || !saved.nd) return;
  try {
    const files = await readRepo(saved.movedTo, saved.nd.did);
    renderTree($('tree-b'), 'night-desk', files);
    $('moved-line').textContent = `The public directory now says: Night Desk lives at ${display(saved.movedTo)}, as ${saved.nd.handle}. ${files.length} files arrived intact.`;
  } catch { /* shown again after the next move */ }
}

// ---------- Reveal: Night Desk is Elena ----------

/** The verifier's checks, in plain words. The owner line says whose key signed. */
function checkText(keyRef: 'openfederation_owner' | 'atproto', owner: string, pseudonym: string): [string[], string][] {
  return [
    [['genesisHash', 'genesisSignature'], `${pseudonym}’s public entry is genuine and unchanged since day one`],
    [['pseudonymSignature'], `${pseudonym}’s twelve words signed the sentence`],
    [['commitment'], `The sealed note, locked in when ${pseudonym} was created, names this account`],
    [['ownerSignature', 'ownerKeyCurrent'], keyRef === 'openfederation_owner'
      ? `${owner} signed the same sentence with her own key, the one her public entry names`
      : `${owner}’s server signed the same sentence for the account, with the key it holds`],
    [['statement'], 'The sentence names these two accounts'],
  ];
}

/** Elena's half of the proof, as the panel describes it before it is made. */
function renderOwnerPart(): void {
  if (!cfg) return;
  const self = elenaSignsHerself();
  const li = $('owner-part');
  li.innerHTML = '';
  const b = document.createElement('b'); b.textContent = self ? 'Elena signs' : 'Elena’s server signs';
  const s = document.createElement('span');
  s.append(b, self
    ? ' the same sentence with her own key, from her own twelve words. Her server never had it.'
    : ' the same sentence for her, with the key it holds for her account.');
  li.appendChild(s);
  $('reveal-note').textContent = self
    ? 'Her server can’t make Elena’s half: it never held that key. Marko’s account is the usual kind, where the server signs for him.'
    : 'Elena’s account is the usual kind: her server holds her key and signs her half for her. With an account that holds its own key, only she could.';
  ($('btn-contrast') as HTMLButtonElement).hidden = !cfg.impostor.contrast;
}

function renderReveal(): void {
  const has = !!saved?.bundle;
  $('proof-parts').classList.toggle('ready', has);
  $('reveal-state').textContent = has ? 'ready to hand over' : 'not made yet';
  ($('btn-reveal') as HTMLButtonElement).disabled = has || !saved?.nd;
  ($('btn-check') as HTMLButtonElement).disabled = !has;
  ($('btn-impostor') as HTMLButtonElement).disabled = !has;
  ($('btn-contrast') as HTMLButtonElement).disabled = !has;
  renderOwnerPart();
}

/** Check a reveal with the verifier (run.ts), as `ofc pseudonym verify --online` does, and say who signed. */
async function checkProof(bundle: RevealBundle, claimant: string, pseudonym = 'Night Desk', impostor = false): Promise<void> {
  const r = await api<{ valid: boolean; checks: { name: string; ok: boolean }[]; ownerAttestation?: 'person' | 'pds-held-key' | 'unchecked' }>('/api/verify-reveal', { bundle });
  const keyRef = bundle.version === 2 ? bundle.owner.keyRef : 'atproto';
  const ul = $('checks');
  ul.hidden = false;
  ul.innerHTML = '';
  for (const [names, text] of checkText(keyRef, claimant, pseudonym)) {
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
    ? `${pseudonym} belongs to ${claimant}.`
    : impostor
      ? `${claimant} copied Elena’s proof and put his own name in it. Night Desk never signed that, and the sealed note doesn’t name him.`
      : 'This proof doesn’t hold up.';
  v.append(s, t);
  // Who signed the owner's half: the person (their own key) or their server (the key it holds).
  const who = $('reveal-signer');
  who.hidden = !r.valid;
  who.className = `signer ${r.ownerAttestation === 'person' ? 'is-person' : 'is-server'}`;
  who.textContent = r.ownerAttestation === 'person'
    ? `Signed by ${claimant.split(' ')[0]} herself: her own key, from her own twelve words. Her server never had it, so it couldn’t have made this.`
    : `Signed by the server’s key: ${claimant}’s server holds the account’s key and signed for ${claimant === cfg!.elena.name ? 'her' : 'him'}. It shows the account agreed, as far as the server can say.`;
  let fragment: string | null = null;
  try { fragment = bundle.version === 2 ? revealLinkFragment(bundle) : null; } catch { fragment = null; }
  showQr('reveal-qr', fragment);
}

/** Elena's own key signs her half: her identity phrase, from the demo server, used only in this page. */
async function elenaOwnerSigner(): Promise<OwnerSigner> {
  const { phrase } = await api<{ phrase: string }>('/api/elena-phrase');
  const keys = deriveCustodyKeys(phrase);
  return async (statement) => ({ signingKey: keys.ownerDidKey, signature: signOwnerRaw(keys.ownerPrivateKey, statement) });
}

$('btn-reveal').addEventListener('click', busy($('btn-reveal') as HTMLButtonElement, async () => {
  const c = cfg!;
  const nd = saved!.nd!;
  saved!.bundle = await createRevealBundle({
    pdsUrl: c.pdsUrl, plcUrl: c.plcUrl, phrase: nd.phrase, pseudonymDid: nd.did, ownerDid: c.elena.did, ownerAccessJwt: await elenaJwt(),
    // assisted/self: Elena signs; custodial: her server does (signLink), which it refuses for accounts holding their own keys.
    ...(elenaSignsHerself() ? { ownerSigner: await elenaOwnerSigner() } : {}),
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
  await checkProof(b, cfg!.impostor.name, 'Night Desk', true);
  ($('btn-impostor') as HTMLButtonElement).disabled = false;
}));
$('btn-contrast').addEventListener('click', busy($('btn-contrast') as HTMLButtonElement, async () => {
  // Marko's account is the usual kind: his server signs his half of his own pseudonym's proof.
  const { bundle } = await api<{ bundle: RevealBundleV2 }>('/api/contrast-reveal', {});
  await checkProof(bundle, cfg!.impostor.name, cfg!.contrastName);
  ($('btn-contrast') as HTMLButtonElement).disabled = false;
}));


// ---------- Reset ----------

$('btn-reset').addEventListener('click', () => { $('reset-confirm').hidden = false; $('btn-reset').hidden = true; });
$('btn-reset-no').addEventListener('click', () => { $('reset-confirm').hidden = true; $('btn-reset').hidden = false; });
$('btn-stale-reset').addEventListener('click', () => { $('btn-reset-yes').click(); });
$('btn-preflight-again').addEventListener('click', () => { $('btn-reset-yes').click(); });
// Offline: rebuild the servers. Live: forget Night Desk in this browser and
// run the pre-flight again; nothing on the servers is deleted (see --cleanup).
// Live passes stay on this laptop: they can't be collected twice in a month.
$('btn-reset-yes').addEventListener('click', async () => {
  $('reset-confirm').hidden = true; $('btn-reset').hidden = false;
  showStale(false);
  $('preflight').hidden = true;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  saved = null; cfg = null;
  $<HTMLTextAreaElement>('login-words').value = '';
  $<HTMLInputElement>('word').value = '';
  $('verdict').hidden = true; $('verdict-note').textContent = '';
  $('db-grid').innerHTML = ''; $('db-verdict').hidden = true;
  $('checks').hidden = true; $('reveal-verdict').hidden = true; $('reveal-signer').hidden = true;
  $('reveal-qr').hidden = true; $('prove-qr').hidden = true;
  document.querySelectorAll<HTMLElement>('#move-steps li').forEach((li) => { li.className = ''; });
  await api('/api/reset', {});
  show(0);
  void boot();
});

// ---------- Boot ----------

/** Live pre-flight: one line per check, shown when something is red. */
function renderPreflight(checks: Check[], error: string): void {
  const ul = $('preflight-list');
  ul.innerHTML = '';
  for (const c of checks) {
    const li = document.createElement('li');
    li.className = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unknown';
    const b = document.createElement('b'); b.textContent = c.label;
    li.append(b, ` \u00b7 ${c.detail}`);
    ul.appendChild(li);
  }
  if (!checks.length) {
    const li = document.createElement('li'); li.className = 'bad'; li.textContent = error; ul.appendChild(li);
  }
  $('preflight').hidden = false;
}

function preflightTitle(checks: Check[]): string {
  return checks.map((c) => `${c.ok === true ? '\u2713' : c.ok === false ? '\u2717' : '\u2013'} ${c.label}: ${c.detail}`).join('\n');
}

async function boot(): Promise<void> {
  setStatus('busy', 'Starting the server…');
  for (;;) {
    try {
      const s = await api<{ state: string; error: string; mode: string; checks: Check[] }>('/api/status');
      if (s.state === 'ready') break;
      if (s.state === 'failed') {
        if (s.mode === 'live') {
          setStatus('failed', 'Live pre-flight failed: use the offline demo');
          $('status').title = preflightTitle(s.checks);
          renderPreflight(s.checks, s.error);
        } else {
          setStatus('failed', `Server failed: ${s.error.slice(0, 80)}`);
        }
        return;
      }
      if (s.mode === 'live') setStatus('busy', 'Checking the live servers…');
    } catch { /* demo server restarting */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  cfg = await api<Config>('/api/state');
  load();
  if (saved && saved.elenaDid !== cfg.elena.did) { saved = null; save(); }
  if (cfg.mode === 'live') {
    // Passes collected earlier this month on this laptop (kept by run.ts).
    const w = cfg.wallet;
    if (w && (!saved || !saved.tokens.length)) saved = { ...(saved ?? { elenaDid: cfg.elena.did }), tokens: w.tokens, spent: w.spent };
    else if (w && saved && w.spent > saved.spent) saved.spent = w.spent;
    save();
    showStale(false);
    setLiveStatus();
    $('status').title = preflightTitle(cfg.checks);
    $('reset-question').textContent = 'Forget Night Desk in this browser? Nothing on the servers is deleted.';
  } else {
    showStale((cfg.used.passesCollected && !saved?.tokens.length) || (cfg.used.pseudonymExists && !saved?.nd));
    setStatus('ready', 'Local server ready · offline');
    $('status').title = '';
  }
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
