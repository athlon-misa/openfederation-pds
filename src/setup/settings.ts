/**
 * What the setup wizard asks, checked, and turned into the environment
 * variables the server already understands (#405). Pure: no I/O.
 *
 * Every message here is shown to the person running the wizard, so they are
 * written in plain words and say what to do, not what went wrong inside.
 */
import { isStrongPassword, isValidEmail, isWellFormedHandle, isValidDomain, normalizeEmail, normalizeHandle } from '../auth/credential-rules.js';
import { CUSTODY_MODES, resolveIdentityPolicy, type CustodyMode } from '../identity/custody-policy.js';

export const DEFAULT_PLC_URL = 'https://plc.openfederation.net';

export type ServerKind = 'community' | 'privacy';

export interface SetupInput {
  kind: ServerKind;
  addresses: {
    publicUrl: string;
    handleDomain: string;
    dashboardUrl?: string;
    plcUrl?: string;
  };
  email:
    | { mode: 'none' }
    | { mode: 'smtp'; host: string; port: number | string; security?: 'starttls' | 'tls'; user?: string; password?: string; from: string };
  admin: { handle: string; email: string; password: string; repeat?: string };
  options: {
    inviteOnly: boolean;
    pseudonyms: boolean;
    custody: CustodyMode[];
    custodyDefault: CustodyMode;
  };
}

export type SetupSection = 'kind' | 'addresses' | 'email' | 'admin' | 'options';
export type FieldErrors = Record<string, string>;

/** The defaults the options step starts from, per kind of server. */
export function defaultOptions(kind: ServerKind): SetupInput['options'] {
  return kind === 'privacy'
    ? { inviteOnly: true, pseudonyms: true, custody: [...CUSTODY_MODES], custodyDefault: 'self' }
    : { inviteOnly: true, pseudonyms: false, custody: [...CUSTODY_MODES], custodyDefault: 'custodial' };
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * A web address with nothing after the host: https, or http on this machine
 * when `allowLocalHttp`. Returns the origin, or an error message.
 */
export function parseOrigin(raw: string, allowLocalHttp: boolean): { origin: string; host: string } | { error: string } {
  let value = raw.trim();
  if (!value) return { error: 'Enter an address.' };
  if (!/^[a-z]+:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'That is not a web address. It should look like https://pds.example.org' };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    return { error: 'Use the address on its own, with nothing after the domain (no path, no ?…).' };
  }
  if (url.protocol === 'http:' && !(allowLocalHttp && isLocalHost(url.hostname))) {
    return { error: 'The address must start with https:// so connections to it are encrypted.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'The address must start with https://' };
  }
  if (!isLocalHost(url.hostname) && !isValidDomain(url.hostname)) {
    return { error: 'That domain does not look right. It should look like pds.example.org' };
  }
  return { origin: url.origin, host: url.host };
}

/** Plain string steps, not regexes over the input, so a long run of '/' or '.' stays cheap. */
export function normalizeHandleDomain(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (v.startsWith('https://')) v = v.slice(8);
  else if (v.startsWith('http://')) v = v.slice(7);
  let start = 0;
  while (start < v.length && (v[start] === '.' || v[start] === '@')) start++;
  let end = v.length;
  while (end > start && v[end - 1] === '/') end--;
  return v.slice(start, end);
}

export function validateSection(section: SetupSection, input: Partial<SetupInput>, allowLocalHttp: boolean): FieldErrors {
  const errors: FieldErrors = {};
  switch (section) {
    case 'kind':
      if (input.kind !== 'community' && input.kind !== 'privacy') errors.kind = 'Choose the kind of server.';
      break;
    case 'addresses': {
      const a = input.addresses;
      if (!a) { errors.publicUrl = 'Enter the server\'s address.'; break; }
      const pub = parseOrigin(str(a.publicUrl), allowLocalHttp);
      if ('error' in pub) errors.publicUrl = pub.error;
      const domain = normalizeHandleDomain(str(a.handleDomain));
      if (!domain) errors.handleDomain = 'Enter the domain people\'s names will end with, like example.org';
      else if (!isValidDomain(domain) && !(allowLocalHttp && domain === 'localhost')) errors.handleDomain = 'That domain does not look right. It should look like example.org';
      if (str(a.dashboardUrl)) {
        const dash = parseOrigin(str(a.dashboardUrl), allowLocalHttp);
        if ('error' in dash) errors.dashboardUrl = dash.error;
      }
      if (str(a.plcUrl)) {
        const plc = parseOrigin(str(a.plcUrl), allowLocalHttp);
        if ('error' in plc) errors.plcUrl = plc.error;
      }
      break;
    }
    case 'email': {
      const e = input.email;
      if (!e || (e.mode !== 'none' && e.mode !== 'smtp')) { errors.mode = 'Choose how this server sends email.'; break; }
      if (e.mode === 'smtp') {
        if (!str(e.host) || /[\s/:]/.test(str(e.host))) errors.host = 'Enter the mail server name your provider gave you, like smtp.example.com';
        const port = Number(e.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Enter the port number your provider gave you (often 587 or 465).';
        if (!isValidEmail(str(e.from))) errors.from = 'Enter the address emails are sent from, like noreply@example.org';
        if (str(e.user) && !str(e.password)) errors.password = 'Enter the password for this mail account.';
      }
      break;
    }
    case 'admin': {
      const a = input.admin;
      const handle = normalizeHandle(str(a?.handle));
      if (!isWellFormedHandle(handle)) errors.handle = 'Use 3 to 30 lowercase letters, digits or dashes (no dash at the start or end).';
      if (!isValidEmail(str(a?.email))) errors.email = 'Enter an email address you can read.';
      const password = typeof a?.password === 'string' ? a.password : '';
      if (!isStrongPassword(password)) errors.password = 'Use at least 10 characters, with at least three of: lowercase letters, capitals, digits, symbols.';
      else if (a?.repeat !== undefined && a.repeat !== password) errors.repeat = 'The two passwords are different.';
      break;
    }
    case 'options': {
      const o = input.options;
      const custody = Array.isArray(o?.custody) ? o!.custody : [];
      if (custody.length === 0 || custody.some((m) => !(CUSTODY_MODES as readonly string[]).includes(m))) {
        errors.custody = 'Offer at least one way to look after accounts.';
      } else if (!custody.includes(o!.custodyDefault)) {
        errors.custodyDefault = 'The first choice offered must be one of the ways you allow.';
      }
      break;
    }
  }
  return errors;
}

export const SECTIONS: SetupSection[] = ['kind', 'addresses', 'email', 'admin', 'options'];

export function validateAll(input: Partial<SetupInput>, allowLocalHttp: boolean): Partial<Record<SetupSection, FieldErrors>> {
  const all: Partial<Record<SetupSection, FieldErrors>> = {};
  for (const section of SECTIONS) {
    const errors = validateSection(section, input, allowLocalHttp);
    if (Object.keys(errors).length > 0) all[section] = errors;
  }
  return all;
}

export interface ResolvedSetup {
  /** Variables for the settings file, secrets not included. */
  env: Record<string, string>;
  admin: { handle: string; email: string };
  publicOrigin: string;
  publicHost: string;
  handleDomain: string;
  dashboardOrigin: string | null;
}

/** The checked input as environment variables. Call validateAll first. */
export function resolveSetup(input: SetupInput, allowLocalHttp: boolean): ResolvedSetup {
  const pub = parseOrigin(input.addresses.publicUrl, allowLocalHttp) as { origin: string; host: string };
  const handleDomain = normalizeHandleDomain(input.addresses.handleDomain);
  const dashboard = str(input.addresses.dashboardUrl) ? (parseOrigin(input.addresses.dashboardUrl!, allowLocalHttp) as { origin: string }).origin : null;
  const plc = str(input.addresses.plcUrl) ? (parseOrigin(input.addresses.plcUrl!, allowLocalHttp) as { origin: string }).origin : DEFAULT_PLC_URL;
  const custody = CUSTODY_MODES.filter((m) => input.options.custody.includes(m));

  const env: Record<string, string> = {
    OPENFEDERATION_PROFILE: input.kind,
    PDS_SERVICE_URL: pub.origin,
    PDS_HOSTNAME: new URL(pub.origin).hostname,
    HANDLE_SUFFIX: `.${handleDomain}`,
    PLC_DIRECTORY_URL: plc,
  };
  if (dashboard) {
    env.WEB_UI_URL = dashboard;
    env.CORS_ORIGINS = dashboard;
  }
  if (input.email.mode === 'smtp') {
    const e = input.email;
    const port = Number(e.port);
    env.SMTP_HOST = str(e.host);
    env.SMTP_PORT = String(port);
    env.SMTP_SECURE = (e.security ?? (port === 465 ? 'tls' : 'starttls')) === 'tls' ? 'true' : 'false';
    if (str(e.user)) {
      env.SMTP_USER = str(e.user);
      env.SMTP_PASSWORD = e.password ?? '';
    }
    env.SMTP_FROM = str(e.from);
  } else {
    env.ALLOW_NO_EMAIL = 'true';
  }
  env.INVITE_REQUIRED = input.options.inviteOnly ? 'true' : 'false';
  env.PSEUDONYMS_ENABLED = input.options.pseudonyms ? 'true' : 'false';
  env.IDENTITY_CUSTODY_ALLOWED = custody.join(',');
  env.IDENTITY_CUSTODY_DEFAULT = input.options.custodyDefault;

  // The same check the server runs when it starts, so a choice it would
  // refuse is caught here instead of after the restart.
  resolveIdentityPolicy(env);

  return {
    env,
    admin: { handle: normalizeHandle(input.admin.handle), email: normalizeEmail(input.admin.email) },
    publicOrigin: pub.origin,
    publicHost: new URL(pub.origin).hostname,
    handleDomain,
    dashboardOrigin: dashboard,
  };
}

export interface DnsRecord {
  /** What the record is for, in plain words. */
  purpose: string;
  type: 'CNAME';
  name: string;
  value: string;
  required: boolean;
  note?: string;
}

const PLATFORM_HOST = /\.(up\.railway\.app|railway\.app|onrender\.com|fly\.dev|herokuapp\.com)$/i;

/**
 * The DNS records to add. `platformHost` is the address the hosting platform
 * gave this server (on Railway, RAILWAY_PUBLIC_DOMAIN), which is what a
 * custom domain points at.
 */
export function dnsRecords(
  r: Pick<ResolvedSetup, 'publicHost' | 'handleDomain' | 'dashboardOrigin'>,
  platformHost: string | null,
  dashboardPlatformHost: string | null,
): DnsRecord[] {
  const records: DnsRecord[] = [];
  const target = platformHost || 'the address your hosting provider gave this server';
  if (!PLATFORM_HOST.test(r.publicHost) && !isLocalHost(r.publicHost) && r.publicHost !== platformHost) {
    records.push({
      purpose: 'Sends your server\'s address to this server',
      type: 'CNAME',
      name: r.publicHost,
      value: target,
      required: true,
      note: 'On Railway, also add this domain under the service\'s Settings, Networking, Custom Domain. Railway then shows the exact value to use and may ask for one more record to prove the domain is yours.',
    });
  }
  records.push({
    purpose: 'Lets other apps confirm people\'s names (like alice.' + r.handleDomain + ') belong to this server',
    type: 'CNAME',
    name: `*.${r.handleDomain}`,
    value: r.publicHost,
    required: false,
    note: 'Only needed for apps outside this server. On Railway, also add *.' + r.handleDomain + ' as a custom domain on the server so the names get a certificate.',
  });
  if (r.dashboardOrigin) {
    const dashHost = new URL(r.dashboardOrigin).hostname;
    if (!PLATFORM_HOST.test(dashHost) && !isLocalHost(dashHost) && dashHost !== dashboardPlatformHost) {
      records.push({
        purpose: 'Sends the dashboard\'s address to the dashboard',
        type: 'CNAME',
        name: dashHost,
        value: dashboardPlatformHost || 'the address your hosting provider gave the dashboard',
        required: true,
        note: 'On Railway, add this domain to the dashboard service the same way, then follow "Changing the dashboard address" in the install guide.',
      });
    }
  }
  return records;
}

export interface ChecklistItem { title: string; detail: string }

/** What is left once the wizard is done. */
export function afterInstallChecklist(r: Pick<ResolvedSetup, 'env' | 'handleDomain'>): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  items.push({
    title: 'Keep a copy of your settings file',
    detail: 'Use the Download settings file button at the end of setup, and store the file somewhere private, such as a password manager. Without it, the keys kept in your database cannot be unlocked if the server\'s disk is lost.',
  });
  items.push({
    title: 'Turn on backups',
    detail: 'Back up the database (on Railway: the Postgres service, Backups tab) and the server\'s disk, where the settings file and uploaded images live.',
  });
  if (r.env.ALLOW_NO_EMAIL === 'true') {
    items.push({
      title: 'Set up email when you can',
      detail: 'Until then, nobody can reset a forgotten password or recover an account by email, and nobody is told when their account is signed in elsewhere.',
    });
  } else {
    const fromDomain = (r.env.SMTP_FROM || '').split('@')[1] || r.handleDomain;
    items.push({
      title: 'Protect your email from forgery',
      detail: `Add SPF, DKIM and DMARC records for ${fromDomain} (your email provider shows the exact records). Without them, mail from your server is more likely to land in spam. A safe start for DMARC is a TXT record named _dmarc.${fromDomain} with the value v=DMARC1; p=none; rua=mailto:postmaster@${fromDomain}`,
    });
  }
  items.push({
    title: 'Say where security problems should be reported',
    detail: 'Set the SECURITY_CONTACT variable to an email address or web page, so people who find a problem know how to reach you. It is published at /.well-known/security.txt.',
  });
  items.push({
    title: 'Check the server now and then',
    detail: 'The /health page shows whether the database and email are working. A free uptime monitor can check it every few minutes and tell you when it is down.',
  });
  return items;
}
