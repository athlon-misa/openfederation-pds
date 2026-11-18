/** Email helpers for the reader sign-in step. */

/** user@domain.tld, at most 254 characters, checked without a backtracking regex. */
export function isPlausibleEmail(email: string): boolean {
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(user.length - 1, 6)))}@${domain}`;
}
