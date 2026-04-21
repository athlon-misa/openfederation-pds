/**
 * Sign-In With OpenFederation (SIWOF) — CAIP-122 message construction.
 *
 * CAIP-122 ("Sign-In With X") defines a human-readable message format a
 * user's wallet signs to prove control of an address, scoped to a specific
 * dApp audience. It's the chain-agnostic generalization of EIP-4361 (SIWE)
 * — EVM-flavored CAIP-122 IS SIWE, and the same format extends to Solana
 * and any other CAIP-2 chain.
 *
 * We build the canonical string here, issue it from signInChallenge, and
 * re-parse + validate it at signInAssert. Both sides use the exact same
 * code path so dApps can independently re-derive the message from the
 * claim fields if they need to.
 */

export interface SiwofMessageFields {
  /** Domain (host[:port]) requesting the sign-in, per CAIP-122. */
  domain: string;
  /** CAIP-10 account ID: "{chainIdCaip2}:{address}". */
  accountCaip10: string;
  /** CAIP-2 chain identifier (e.g. "eip155:1", "solana:mainnet"). */
  chainIdCaip2: string;
  /** Full URI of the dApp (scheme + host + path). */
  uri: string;
  /** Cryptographic nonce unique per sign-in attempt. */
  nonce: string;
  /** ISO-8601 timestamp at which the request was issued. */
  issuedAt: string;
  /** ISO-8601 timestamp after which the message must not be accepted. */
  expirationTime?: string;
  /** ISO-8601 timestamp before which the message must not be accepted. */
  notBefore?: string;
  /** Optional request identifier. */
  requestId?: string;
  /** Optional statement shown to the user in the signing prompt. */
  statement?: string;
  /** Optional resource URIs the signature also vouches for. */
  resources?: string[];
  /** CAIP-122 version — always "1". */
  version: '1';
}

/** Canonical SIWOF/CAIP-122 message text. */
export function buildSiwofMessage(f: SiwofMessageFields): string {
  const lines: string[] = [];
  // Address from CAIP-10 for the opening line (SIWE convention is just the
  // address; CAIP-122 follows suit).
  const address = f.accountCaip10.split(':').slice(-1)[0];

  lines.push(`${f.domain} wants you to sign in with your ${chainLabel(f.chainIdCaip2)} account:`);
  lines.push(address);
  lines.push('');

  if (f.statement) {
    lines.push(f.statement);
    lines.push('');
  }

  lines.push(`URI: ${f.uri}`);
  lines.push(`Version: ${f.version}`);
  lines.push(`Chain ID: ${f.chainIdCaip2}`);
  lines.push(`Nonce: ${f.nonce}`);
  lines.push(`Issued At: ${f.issuedAt}`);
  if (f.expirationTime) lines.push(`Expiration Time: ${f.expirationTime}`);
  if (f.notBefore) lines.push(`Not Before: ${f.notBefore}`);
  if (f.requestId) lines.push(`Request ID: ${f.requestId}`);

  if (f.resources && f.resources.length > 0) {
    lines.push('Resources:');
    for (const r of f.resources) lines.push(`- ${r}`);
  }

  return lines.join('\n');
}

/**
 * Parse a CAIP-122 message back into structured fields. Tolerant of missing
 * optional lines; strict on required ones so a tampered message is caught
 * before the signature check would miss it.
 */
export function parseSiwofMessage(text: string): SiwofMessageFields {
  const lines = text.split('\n');
  if (lines.length < 6) throw new Error('SIWOF message truncated');

  const header = lines[0];
  const addressLine = lines[1];
  if (!header.includes('wants you to sign in with your')) {
    throw new Error('SIWOF header line malformed');
  }
  const domain = header.split(' wants you to')[0];

  let cursor = 2;
  // Skip blank + optional statement block (statement ends at a blank line).
  let statement: string | undefined;
  if (lines[cursor] === '') cursor++;
  if (cursor < lines.length && !lines[cursor].startsWith('URI:')) {
    const statementLines: string[] = [];
    while (cursor < lines.length && lines[cursor] !== '' && !lines[cursor].startsWith('URI:')) {
      statementLines.push(lines[cursor]);
      cursor++;
    }
    if (statementLines.length > 0) statement = statementLines.join('\n');
    if (lines[cursor] === '') cursor++;
  }

  const kv = new Map<string, string>();
  const resources: string[] = [];
  let inResources = false;
  while (cursor < lines.length) {
    const line = lines[cursor++];
    if (line === '') continue;
    if (line === 'Resources:') { inResources = true; continue; }
    if (inResources) {
      if (line.startsWith('- ')) resources.push(line.slice(2));
      else throw new Error(`Unexpected line in SIWOF Resources: ${line}`);
      continue;
    }
    const m = line.match(/^([A-Za-z ]+): (.+)$/);
    if (!m) throw new Error(`Malformed SIWOF line: ${line}`);
    kv.set(m[1], m[2]);
  }

  const uri = kv.get('URI');
  const version = kv.get('Version');
  const chainIdCaip2 = kv.get('Chain ID');
  const nonce = kv.get('Nonce');
  const issuedAt = kv.get('Issued At');
  if (!uri || version !== '1' || !chainIdCaip2 || !nonce || !issuedAt) {
    throw new Error('SIWOF message missing required fields (URI, Version, Chain ID, Nonce, Issued At)');
  }

  return {
    domain,
    accountCaip10: `${chainIdCaip2}:${addressLine}`,
    chainIdCaip2,
    uri,
    nonce,
    issuedAt,
    expirationTime: kv.get('Expiration Time'),
    notBefore: kv.get('Not Before'),
    requestId: kv.get('Request ID'),
    statement,
    resources: resources.length > 0 ? resources : undefined,
    version: '1',
  };
}

/**
 * Normalize a dApp audience URL into a canonical form usable as both the
 * `domain` line of the SIWOF message and the `aud` claim of the didToken.
 * Matches the wallet-consent origin canonicalization so grants transfer.
 */
export function normalizeSiwofAudience(raw: string): { domain: string; uri: string } {
  if (!raw || typeof raw !== 'string') throw new Error('audience is required');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('audience must be a full URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('audience must use http or https');
  }
  // CAIP-122 'domain' is host[:port] (no scheme). 'URI' retains the full path.
  return {
    domain: url.host.toLowerCase(),
    uri: `${url.protocol}//${url.host.toLowerCase()}${url.pathname === '/' ? '' : url.pathname}`,
  };
}

/** Map our chain enum + optional CAIP-2 override to a canonical CAIP-2 string. */
export function resolveChainIdCaip2(chain: 'ethereum' | 'solana', override?: string): string {
  if (override) return override;
  if (chain === 'ethereum') return 'eip155:1';       // default: mainnet
  if (chain === 'solana') return 'solana:mainnet';   // informal — strict CAIP uses genesis-hash prefix
  throw new Error(`Unsupported chain: ${chain}`);
}

/** CAIP-10 account identifier: "{chainIdCaip2}:{address}". */
export function toCaip10(chainIdCaip2: string, address: string): string {
  return `${chainIdCaip2}:${address}`;
}

function chainLabel(chainIdCaip2: string): string {
  if (chainIdCaip2.startsWith('eip155:')) return 'Ethereum';
  if (chainIdCaip2.startsWith('solana:')) return 'Solana';
  return chainIdCaip2;
}
