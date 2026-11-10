/**
 * Turning a stored Tier 2 secret back into something that can sign.
 *
 * A Tier 2 secret is one of two things, wrapped the same way: a BIP-39
 * mnemonic (a wallet created at Tier 2), or a raw private key (a wallet the
 * server generated at Tier 1 and the user then upgraded). The blob says which
 * in `kind`. Blobs written before that field existed are recognised by
 * content, so wallets upgraded by an older SDK unlock as well.
 */
import { isValidMnemonic } from './mnemonic.js';
import { unwrapMnemonic, type WrappedBlob } from './wrap.js';
import { WalletSession, type SupportedChain } from './wallet-session.js';

export type WrappedSecretKind = 'mnemonic' | 'raw-private-key';
export type TaggedWrappedBlob = WrappedBlob & { kind?: WrappedSecretKind };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Unwrap a stored secret and say what it is. Throws on a wrong passphrase. */
export async function unwrapSecret(
  blobJson: string,
  passphrase: string,
): Promise<{ secret: string; kind: WrappedSecretKind }> {
  const blob = JSON.parse(blobJson) as TaggedWrappedBlob;
  const secret = await unwrapMnemonic(blob, passphrase);
  const kind = blob.kind ?? (isValidMnemonic(secret) ? 'mnemonic' : 'raw-private-key');
  return { secret, kind };
}

/** Unwrap a stored secret into a session that can sign for `chain`. */
export async function sessionFromWrappedSecret(
  blobJson: string,
  passphrase: string,
  chain: SupportedChain,
): Promise<WalletSession> {
  const { secret, kind } = await unwrapSecret(blobJson, passphrase);
  if (kind === 'mnemonic') return new WalletSession(secret);
  return WalletSession.fromPrivateKey(chain, base64ToBytes(secret));
}
