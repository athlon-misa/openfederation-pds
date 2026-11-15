/**
 * Device signing state (#240, ADR-003 decision 14).
 *
 * When device signing is on, the person's device holds the repo signing key
 * and the DID's `atproto` verification method names it. A commit this server
 * signed would fail verification at every relay and app, and signing one at
 * all would be the server speaking for the person. So every server-side write
 * into such an account's repository refuses, before anything is signed; the
 * device signs instead (net.openfederation.repo.prepareCommit / submitCommit).
 *
 * `RepoEngine` checks this on every commit it signs, so a write path that
 * forgets to check still cannot sign. Handlers that write into a user's repo
 * also check up front (`respondIfDeviceSigning` / `assertServerMaySign`),
 * before any other state changes, so nothing is left half-done.
 */
import type { Response } from 'express';
import { query } from '../db/client.js';
import { HttpError } from '../xrpc/errors.js';
import { actingDevice } from './device-action-context.js';

export const DEVICE_SIGNING_REQUIRED = 'DeviceSigningRequired';

const DEFAULT_MESSAGE =
  'This account signs its repository on its own device (device signing is on), so the server cannot write to it. '
  + 'Sign the change on the device: net.openfederation.repo.prepareAction (this method) or prepareCommit (record writes), '
  + 'then net.openfederation.repo.submitCommit.';

export class DeviceSigningRequiredError extends HttpError {
  readonly did: string;
  constructor(did: string, message: string = DEFAULT_MESSAGE) {
    super(403, DEVICE_SIGNING_REQUIRED, message);
    this.name = 'DeviceSigningRequiredError';
    this.did = did;
  }
}

/** Whether `did` is an account here with device signing on. Communities and unknown DIDs: false. */
export async function isDeviceSigningOn(did: string): Promise<boolean> {
  const result = await query<{ device_signing: boolean }>(
    'SELECT device_signing FROM users WHERE did = $1',
    [did],
  );
  return result.rows[0]?.device_signing === true;
}

/**
 * Throw `DeviceSigningRequiredError` if the server may not sign for `did`.
 * Strict: `RepoEngine` uses it, so no commit is ever signed with the
 * server's key for such an account, whatever the request.
 */
export async function assertServerMaySign(did: string, message?: string): Promise<void> {
  if (await isDeviceSigningOn(did)) throw new DeviceSigningRequiredError(did, message);
}

/**
 * For a method that writes for `did`: go ahead when the server may sign for
 * it, or when `did`'s device is taking part in this request
 * (net.openfederation.repo.prepareAction / submitCommit, phase 2 of #240), in
 * which case the write itself is routed to the device (`writeRepoAs`,
 * `signAsAuthor`). Otherwise throw `DeviceSigningRequiredError`.
 */
export async function assertMayWriteFor(did: string, message?: string): Promise<void> {
  if (actingDevice(did)) return;
  await assertServerMaySign(did, message);
}

/**
 * For handlers with their own error rendering: answer 403 DeviceSigningRequired
 * and return true when the server may not sign for `did` (and `did`'s device
 * is not taking part in this request, see `assertMayWriteFor`).
 */
export async function respondIfDeviceSigning(res: Response, did: string, message?: string): Promise<boolean> {
  if (actingDevice(did)) return false;
  if (!(await isDeviceSigningOn(did))) return false;
  res.status(403).json({ error: DEVICE_SIGNING_REQUIRED, message: message ?? DEFAULT_MESSAGE });
  return true;
}
