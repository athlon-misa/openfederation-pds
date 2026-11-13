/**
 * @open-federation/sdk/custody — client side of `assisted` and `self` custody
 * (docs/adr/ADR-003-custody-modes.md): phrase keys, PLC operations, owner
 * signatures (raw and passkey), and daily passkey unlock. Not part of the
 * /sdk/v1.js browser bundle.
 */
export * from './keys.js';
export * from './plc.js';
export * from './owner-signature.js';
export * from './device-unlock.js';
export { didKeyFor, parseDidKey, base64UrlEncode, base64UrlDecode, type KeyCurve } from './encoding.js';
export * from './owner-record.js';
export * from './repo-watch.js';
export * from './leave.js';
export * from './recovery.js';
export * from './device-signing.js';
export {
  splitRecoveryPhrase, combineRecoveryShares, parseRecoveryShare, RecoveryShareError,
  RECOVERY_SHARE_VERSION, RECOVERY_SHARE_WORDS, RECOVERY_SHARE_CODE_PREFIX, MAX_RECOVERY_SHARES,
  type RecoveryShare, type RecoveryShareErrorCode,
} from './recovery-shares.js';
export { MemoryStorageAdapter, LocalStorageAdapter, type StorageAdapter } from '../storage.js';
