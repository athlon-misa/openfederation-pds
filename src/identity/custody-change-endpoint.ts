/**
 * Shared by identity.prepareCustodyChange and identity.finalizeCustodyChange
 * (ADR-003, decision 5): who may change, and how. Rules in custody-change.ts.
 */
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser, requireLocalAccount } from '../auth/guards.js';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';
import { isCustodyMode, type CustodyMode } from './custody-policy.js';
import { CustodyChangeError, type ChangeInputs } from './custody-change.js';

interface Account { id: string; did: string; handle: string; email: string | null; passwordHash: string | null; mode: CustodyMode }

/** Shared checks: a local, approved account with a custody mode, the right password, an allowed target. */
export async function authorize(req: AuthRequest, res: Response): Promise<{ account: Account; target: CustodyMode } | null> {
  if (!requireAuth(req, res) || !requireLocalAccount(req, res) || !requireApprovedUser(req, res)) return null;
  const row = (await query<{ id: string; handle: string; email: string | null; password_hash: string | null; custody_mode: string | null; device_signing: boolean }>(
    'SELECT id, handle, email, password_hash, custody_mode, device_signing FROM users WHERE did = $1', [req.auth!.did])).rows[0];
  if (!row || !isCustodyMode(row.custody_mode) || !row.password_hash) {
    throw new CustodyChangeError(400, 'InvalidRequest', 'This account has no custody mode to change');
  }
  const target = req.body?.targetMode;
  if (!isCustodyMode(target)) throw new CustodyChangeError(400, 'InvalidRequest', 'targetMode must be custodial, assisted or self');
  if (!config.identity.custodyAllowed.includes(target)) throw new CustodyChangeError(403, 'CustodyModeNotAllowed', `This server does not allow ${target} accounts`);
  // Custodial accounts cannot have device signing (#240): the change keeps the
  // DID's atproto key, which would leave a custodial account whose repo only
  // its device can write.
  if (target === 'custodial' && row.device_signing) {
    throw new CustodyChangeError(403, 'DeviceSigningRequired', 'Turn device signing off first (point the DID back at this server\'s key, then disableDeviceSigning)');
  }
  const check = await checkPasswordWithLockout(row.id, row.password_hash, typeof req.body?.password === 'string' ? req.body.password : '');
  if (!check.ok) {
    if (check.reason === 'locked') throw new CustodyChangeError(429, 'AccountLocked', `Too many failed attempts. Try again in ${check.retryAfterSeconds} seconds.`);
    throw new CustodyChangeError(401, 'InvalidPassword', 'Password is incorrect');
  }
  return { account: { id: row.id, did: req.auth!.did, handle: row.handle, email: row.email, passwordHash: row.password_hash, mode: row.custody_mode }, target };
}

export function inputsOf(body: Record<string, unknown> | undefined): ChangeInputs {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { userRotationDidKey: str(body?.userRotationDidKey), ownerDidKey: str(body?.ownerDidKey), pdsRotationDidKey: str(body?.pdsRotationDidKey) };
}

export function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof CustodyChangeError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  console.error(`Error in ${what}:`, error instanceof Error ? error.message : error);
  if (!res.headersSent) res.status(500).json({ error: 'InternalServerError', message: `Failed to ${what}` });
}

export async function submitToPlc(did: string, signed: object): Promise<void> {
  const res = await fetch(`${config.plc.directoryUrl}/${did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed),
  });
  if (!res.ok) throw new CustodyChangeError(502, 'UpstreamFailure', `The PLC directory refused the update (${res.status})`);
}

