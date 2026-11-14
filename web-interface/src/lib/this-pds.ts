import { pdsUrl } from './runtime-config';

/**
 * The PDS this dashboard serves. Kept apart from the auth store so signed-out
 * pages need not load it. Read once, when the module loads: in the browser the
 * runtime config (/runtime-config.js) has run by then; see runtime-config.ts.
 */
export const THIS_PDS = pdsUrl();
/** Its service DID, when pinned at build time (pen-name logins are signed for it); empty when not. */
export const THIS_PDS_SERVICE_DID = (process.env.NEXT_PUBLIC_PDS_SERVICE_DID || '').trim();
