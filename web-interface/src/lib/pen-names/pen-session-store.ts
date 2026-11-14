/**
 * Where a pen name's session lives: this tab's sessionStorage, under its own
 * key, apart from the person's session. Kept tiny so the auth store can sign
 * the pen name out on logout without loading the pen-name code.
 */
export const PEN_SESSION_KEY = 'of.penName.session.v1';

/** Signs the pen name out of this tab (also called when the person signs out). */
export function forgetPenSession(): void {
  try { sessionStorage.removeItem(PEN_SESSION_KEY); } catch { /* nothing to remove */ }
}
