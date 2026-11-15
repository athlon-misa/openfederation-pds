/**
 * The request-scoped state of a device-signed action (#240 phase 2).
 *
 * Kept apart from `device-actions.ts` so `RepoEngine` can read it without an
 * import cycle. See `device-actions.ts` for what the two modes mean.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BatchOp, PreparedDeviceCommit } from './repo-engine.js';

/** A member record signed by its author but stored elsewhere (a private community's repo). */
export interface PlannedAuthorRecord {
  /** The repository the record goes into (the community's). */
  repo: string;
  collection: string;
  rkey: string;
  /** The record exactly as the author signs it: with `author`, without `authorSig`. */
  record: Record<string, unknown>;
}

export type NeededSignature =
  | { kind: 'commit'; ops: BatchOp[] }
  | { kind: 'authorSig'; planned: PlannedAuthorRecord };

/** Running a method to find out what the device must sign. Stops at the first write it needs. */
export interface PrepareContext {
  mode: 'prepare';
  did: string;
  needed?: NeededSignature;
}

/** Running the same method again, with the device's signature, to finish it. */
export interface FinishContext {
  mode: 'finish';
  did: string;
  kind: 'commit' | 'authorSig';
  /** kind commit: the commit the device signed, and the writes it was built from. */
  prepared?: PreparedDeviceCommit;
  plannedOps?: BatchOp[];
  /** kind authorSig: the record the device signed. */
  planned?: PlannedAuthorRecord;
  sig: Uint8Array;
  /** The DID's current atproto key, which the signature verified against. */
  key: string;
  /** Set once the signature has been used; a method gets one. */
  used: boolean;
  commit?: { cid: string; rev: string };
  /** A failure applying the device's signature, reported as is (handlers turn errors into 500s). */
  error?: unknown;
}

export type DeviceActionContext = PrepareContext | FinishContext;

export const deviceActionStore = new AsyncLocalStorage<DeviceActionContext>();

export function deviceActionContext(): DeviceActionContext | undefined {
  return deviceActionStore.getStore();
}

/** True while `did`'s device is taking part in the current request (prepare or finish). */
export function actingDevice(did: string): boolean {
  return deviceActionStore.getStore()?.did === did;
}

/**
 * Thrown at the point where a method running in prepare mode needs the
 * device's signature. Handlers may catch it (most turn errors into a 500);
 * the runner looks at the context instead of the response.
 */
export class DeviceSignatureNeeded extends Error {
  constructor() {
    super('The device signs this write');
    this.name = 'DeviceSignatureNeeded';
  }
}
