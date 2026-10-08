import { issueSession } from '../../src/auth/session-issue.js';

export async function issueSessionForTests(u: { id: string; did: string; handle: string }) {
  const { accessJwt, refreshJwt } = await issueSession({ ...u, email: null, status: 'approved', token_version: 0 });
  return { accessJwt, refreshJwt };
}
