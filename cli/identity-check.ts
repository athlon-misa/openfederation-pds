/**
 * `ofc identity check <handle|did>`: can the rest of the AT Protocol network
 * find this identity? (docs/ATPROTO-NETWORK.md). Read-only, needs no login.
 *
 * Looks up the handle the way any AT Protocol service does (DNS TXT
 * `_atproto.<handle>`, then https://<handle>/.well-known/atproto-did) and the
 * DID in each PLC directory given, and says what is missing.
 */
import dns from 'dns/promises';

export interface DirectoryResult {
  url: string;
  status: 'found' | 'missing' | 'error';
  handle?: string | null;
  pds?: string | null;
  error?: string;
}

export interface IdentityCheck {
  input: string;
  handle: string | null;
  did: string | null;
  dnsTxt: { did: string | null; error?: string } | null;
  wellKnown: { did: string | null; error?: string } | null;
  directories: DirectoryResult[];
  problems: string[];
}

const PUBLIC_PLC = 'https://plc.directory';
const DID_RE = /^did:(plc|web):[a-zA-Z0-9._:%-]+$/;

async function txtDid(handle: string): Promise<{ did: string | null; error?: string }> {
  try {
    const records = await dns.resolveTxt(`_atproto.${handle}`);
    const values = records.map((r) => r.join('')).filter((v) => v.startsWith('did='));
    return { did: values.length === 1 ? values[0].slice(4) : null, ...(values.length > 1 ? { error: 'more than one did= record' } : {}) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { did: null, error: code === 'ENOTFOUND' || code === 'ENODATA' ? 'no record' : String(code ?? err) };
  }
}

async function wellKnownDid(handle: string, timeoutMs: number): Promise<{ did: string | null; error?: string }> {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) return { did: null, error: `HTTP ${res.status}` };
    const text = (await res.text()).trim();
    return DID_RE.test(text) ? { did: text } : { did: null, error: 'not a DID' };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { did: null, error: cause ?? (err instanceof Error ? err.message : String(err)) };
  }
}

async function plcLookup(url: string, did: string, timeoutMs: number): Promise<DirectoryResult> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/${did}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { url, status: 'missing' };
    if (!res.ok) return { url, status: 'error', error: `HTTP ${res.status}` };
    const doc = await res.json() as { alsoKnownAs?: string[]; service?: { id?: string; serviceEndpoint?: string }[] };
    const aka = doc.alsoKnownAs?.find((a) => a.startsWith('at://'));
    const pds = doc.service?.find((s) => s.id === '#atproto_pds')?.serviceEndpoint ?? null;
    return { url, status: 'found', handle: aka ? aka.slice(5) : null, pds };
  } catch (err) {
    return { url, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkIdentity(input: string, opts: { directories: string[]; timeoutMs?: number }): Promise<IdentityCheck> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const value = input.trim().replace(/^@/, '').replace(/^at:\/\//, '');
  const out: IdentityCheck = { input, handle: null, did: null, dnsTxt: null, wellKnown: null, directories: [], problems: [] };

  if (value.startsWith('did:')) {
    out.did = value;
  } else {
    out.handle = value.toLowerCase();
    [out.dnsTxt, out.wellKnown] = await Promise.all([txtDid(out.handle), wellKnownDid(out.handle, timeoutMs)]);
    out.did = out.dnsTxt.did ?? out.wellKnown.did;
    if (!out.did) {
      out.problems.push(`The handle does not resolve: add a DNS TXT record _atproto.${out.handle} = did=<DID>, or point ${out.handle} at its PDS (wildcard DNS) so https://${out.handle}/.well-known/atproto-did answers.`);
    } else if (out.dnsTxt.did && out.wellKnown.did && out.dnsTxt.did !== out.wellKnown.did) {
      out.problems.push('DNS and the well-known address name different DIDs.');
    }
  }

  if (out.did?.startsWith('did:plc:')) {
    out.directories = await Promise.all(opts.directories.map((u) => plcLookup(u, out.did!, timeoutMs)));
    const found = out.directories.filter((d) => d.status === 'found');
    // Most of the network reads plc.directory only: missing there is the
    // problem. Another directory not knowing a DID is normal (it holds its own).
    const network = out.directories.find((d) => d.url.replace(/\/+$/, '') === PUBLIC_PLC);
    if (network?.status === 'missing') {
      out.problems.push(`${PUBLIC_PLC} does not know ${out.did}: apps that read only it (most of the network) cannot find this identity. See "DIDs: mirror into plc.directory" in docs/ATPROTO-NETWORK.md.`);
    }
    if (found.length === 0 && out.directories.every((d) => d.status !== 'error')) {
      out.problems.push(`No listed directory knows ${out.did}.`);
    }
    if (out.handle && found.some((d) => d.handle && d.handle !== out.handle)) {
      out.problems.push(`The DID document names a different handle (${found.find((d) => d.handle !== out.handle)?.handle}).`);
    }
    if (!out.handle && found[0]?.handle) {
      out.handle = found[0].handle;
    }
  }
  return out;
}
