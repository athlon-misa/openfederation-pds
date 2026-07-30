import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class OutboundFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundFetchError';
  }
}

/** Validate an outbound HTTPS URL and every destination address it resolves to. */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundFetchError('Outbound URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new OutboundFetchError('Outbound URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new OutboundFetchError('Outbound URL must not include credentials');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedAddress(host)) {
    throw new OutboundFetchError('Outbound URL resolves to a private or reserved address');
  }
  if (isIP(host)) return url;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new OutboundFetchError('Outbound URL hostname could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new OutboundFetchError('Outbound URL resolves to a private or reserved address');
  }
  return url;
}

export function isBlockedAddress(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^(?:fc|fd|fe[89ab])/i.test(host)) return true;

  const match = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const ipv4 = match?.[1] ?? host;
  const octets = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const [a, b, c] = octets.slice(1).map(Number);
  if ([a, b, c].some(Number.isNaN) || octets.slice(1).some((part) => Number(part) > 255)) return true;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}
