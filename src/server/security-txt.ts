/**
 * /.well-known/security.txt (RFC 9116): where to report a vulnerability in
 * this instance. Operators set SECURITY_CONTACT (comma-separated email
 * addresses or https URLs); the project's private advisory form is always
 * listed last, for vulnerabilities in the software itself.
 */
const PROJECT_REPORT_FORM = 'https://github.com/athlon-misa/openfederation-pds/security/advisories/new';
const PROJECT_POLICY = 'https://github.com/athlon-misa/openfederation-pds/blob/main/SECURITY.md';
/** RFC 9116 asks for an Expires under a year away; it is recomputed on every request. */
const EXPIRES_AFTER_DAYS = 180;

function contactLine(raw: string): string | null {
  const value = raw.trim();
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) return `mailto:${value}`;
  if (/^mailto:[^\s@<>]+@[^\s@<>]+$/.test(value)) return value;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function buildSecurityTxt(opts: { contacts: string[]; serviceUrl: string; now?: Date }): string {
  const now = opts.now ?? new Date();
  const contacts = [...opts.contacts.map(contactLine).filter((c): c is string => c !== null), PROJECT_REPORT_FORM];
  const expires = new Date(now.getTime() + EXPIRES_AFTER_DAYS * 86_400_000);
  const base = opts.serviceUrl.replace(/\/+$/, '');
  return [
    ...[...new Set(contacts)].map((c) => `Contact: ${c}`),
    `Expires: ${expires.toISOString()}`,
    `Policy: ${PROJECT_POLICY}`,
    'Preferred-Languages: en',
    `Canonical: ${base}/.well-known/security.txt`,
    '',
  ].join('\n');
}

export function securityContactsFromEnv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
