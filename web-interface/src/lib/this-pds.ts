/** The PDS this dashboard was built for. Kept apart from the auth store so signed-out pages need not load it. */
export const THIS_PDS = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';
/** Its service DID, when pinned at build time (pen-name logins are signed for it); empty when not. */
export const THIS_PDS_SERVICE_DID = (process.env.NEXT_PUBLIC_PDS_SERVICE_DID || '').trim();
