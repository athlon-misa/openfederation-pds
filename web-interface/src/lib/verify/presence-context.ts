/**
 * The context an in-person proof's word is signed in, carried in its /verify
 * link as `c=` (#412). Signer and verifier must use the same one.
 *
 * The same values and link rule as @open-federation/pseudonym 0.4
 * (IN_PERSON_CONTEXT, STAGE_PRESENCE_CONTEXT, presenceLinkFragment's
 * `context`), kept here so the dashboard works with 0.3.1, which ignores `c=`:
 * the page reads it and passes it to verifyLink as `presenceContext`.
 */

/** What the dashboard signs a word in. */
export const IN_PERSON_CONTEXT = 'OpenFederation in-person proof';
/** What a link without `c=` was signed in: every link the stage demo made before links named a context. */
export const STAGE_PRESENCE_CONTEXT = 'OpenNewsrooms stage challenge';

const ok = (c: string) => c.length > 0 && c.length <= 200 && !/[\r\n]/.test(c);

/** A presence link's fragment with its context added as `c=`. */
export function withPresenceContext(fragment: string, context: string = IN_PERSON_CONTEXT): string {
  if (!ok(context)) throw new Error('Not a presence context');
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  q.set('c', context);
  return q.toString();
}

/** The context to check a link's word in: its `c=`, else the stage context. Throws on a malformed `c=`. */
export function presenceContextOf(fragment: string): string {
  const c = new URLSearchParams(fragment.replace(/^#/, '')).get('c');
  if (c === null) return STAGE_PRESENCE_CONTEXT;
  if (!ok(c)) throw new Error('the context in this link is not valid');
  return c;
}
