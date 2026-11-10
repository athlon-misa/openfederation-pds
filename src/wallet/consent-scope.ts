/**
 * What a signing consent allows, and the checks that hold a signature to it.
 *
 * A consent used to mean "this dApp may have anything signed with this
 * wallet". It now states its limits, chosen by the user when they approve it:
 *
 *  - `allowedContracts`: the only addresses an Ethereum transaction may be sent
 *    to (or, for Solana, the only programs a transaction may invoke). A
 *    consent that names none signs no transactions at all; message signing is
 *    unaffected.
 *  - `maxValuePerTx` / `maxTotalValue`: the most native value (wei) one
 *    transaction, and all of them together, may move. Absent means none may.
 *  - message signing refuses a sign-in message (SIWE / SIWOF shaped) for a
 *    domain other than the consenting dApp's, so a consent cannot be used to
 *    sign the user in somewhere else.
 */
import bs58 from 'bs58';

export class ConsentScopeRejection extends Error {
  readonly code = 'OutsideConsentScope';
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ConsentScopeRejection';
  }
}

export interface ConsentScope {
  allowedContracts: string[] | null;
  maxValuePerTx: bigint | null;
  maxTotalValue: bigint | null;
}

const UINT256_MAX = (1n << 256n) - 1n;

/** Parse a non-negative integer amount given as a decimal string or number. Null if not one. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n && value <= UINT256_MAX ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77}|0x[0-9a-fA-F]{1,64})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}

/**
 * Validate the scope a dApp asks for. Returns a message for the first problem,
 * or the normalised scope.
 */
export function validateRequestedScope(
  chain: 'ethereum' | 'solana' | undefined,
  input: { allowedContracts?: unknown; maxValuePerTx?: unknown; maxTotalValue?: unknown },
): { ok: true; scope: ConsentScope } | { ok: false; message: string } {
  let allowedContracts: string[] | null = null;
  if (input.allowedContracts !== undefined && input.allowedContracts !== null) {
    if (!Array.isArray(input.allowedContracts) || input.allowedContracts.length === 0 || input.allowedContracts.length > 50) {
      return { ok: false, message: 'allowedContracts must be a list of 1 to 50 addresses' };
    }
    if (!chain) return { ok: false, message: 'allowedContracts needs a chain and walletAddress: name the wallet this consent is for' };
    const normalised: string[] = [];
    for (const raw of input.allowedContracts) {
      if (typeof raw !== 'string') return { ok: false, message: 'allowedContracts entries must be strings' };
      if (chain === 'ethereum') {
        if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return { ok: false, message: `not an Ethereum address: ${raw}` };
        normalised.push(raw.toLowerCase());
      } else {
        let bytes: Uint8Array;
        try { bytes = bs58.decode(raw); } catch { return { ok: false, message: `not a Solana program id: ${raw}` }; }
        if (bytes.length !== 32) return { ok: false, message: `not a Solana program id: ${raw}` };
        normalised.push(raw);
      }
    }
    allowedContracts = [...new Set(normalised)];
  }

  const amount = (name: string, value: unknown): bigint | null | string => {
    if (value === undefined || value === null) return null;
    const parsed = parseAmount(value);
    return parsed === null ? `${name} must be a non-negative integer amount (decimal string, in the chain's smallest unit)` : parsed;
  };
  const perTx = amount('maxValuePerTx', input.maxValuePerTx);
  if (typeof perTx === 'string') return { ok: false, message: perTx };
  const total = amount('maxTotalValue', input.maxTotalValue);
  if (typeof total === 'string') return { ok: false, message: total };
  if ((perTx !== null || total !== null) && chain !== 'ethereum') {
    return { ok: false, message: 'value limits are enforced for Ethereum wallets only' };
  }
  if (perTx !== null && total !== null && perTx > total) {
    return { ok: false, message: 'maxValuePerTx cannot exceed maxTotalValue' };
  }
  return { ok: true, scope: { allowedContracts, maxValuePerTx: perTx, maxTotalValue: total } };
}

/** The domain a sign-in message is for, or null when the message is not one. */
export function signInMessageDomain(message: string): string | null {
  const firstLine = message.split('\n', 1)[0] ?? '';
  const match = /^(\S+) wants you to sign in with your .+ account:$/.exec(firstLine.trim());
  return match ? match[1].toLowerCase() : null;
}

/** Refuse a sign-in message for anywhere but the consenting dApp. */
export function assertMessageInScope(message: string, dappOrigin: string): void {
  const domain = signInMessageDomain(message);
  if (domain === null) return;
  const host = new URL(dappOrigin).host.toLowerCase();
  if (domain !== host) {
    throw new ConsentScopeRejection(
      `This is a sign-in message for ${domain}; the consent was given to ${host} and does not cover signing in elsewhere`,
    );
  }
}

/** Refuse an Ethereum transaction the consent does not cover. Returns the value it moves. */
export function assertEvmTransactionInScope(tx: { to?: unknown; value?: unknown }, scope: ConsentScope): bigint {
  if (!scope.allowedContracts || scope.allowedContracts.length === 0) {
    throw new ConsentScopeRejection('This consent does not name any contracts, so it does not cover signing transactions');
  }
  const to = typeof tx.to === 'string' ? tx.to.toLowerCase() : '';
  if (!scope.allowedContracts.includes(to)) {
    throw new ConsentScopeRejection(`Transactions to ${to || '(contract creation)'} are not covered by this consent`);
  }
  const value = tx.value === undefined || tx.value === null ? 0n : parseAmount(typeof tx.value === 'bigint' ? tx.value : String(tx.value));
  if (value === null) throw new ConsentScopeRejection('Transaction value is not a valid amount');
  if (value > 0n) {
    if (scope.maxValuePerTx === null) throw new ConsentScopeRejection('This consent does not allow moving value');
    if (value > scope.maxValuePerTx) throw new ConsentScopeRejection('Transaction value exceeds this consent\'s per-transaction limit');
  }
  return value;
}

/**
 * The programs a compiled Solana transaction message invokes. Handles legacy
 * and v0 messages; program ids are always among the static account keys.
 */
export function solanaProgramIds(message: Uint8Array): string[] {
  let at = 0;
  const byte = () => {
    if (at >= message.length) throw new Error('truncated message');
    return message[at++];
  };
  const compactU16 = () => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
    }
    throw new Error('bad length');
  };
  if (message[0] & 0x80) at = 1; // versioned message prefix
  at += 3; // header
  const keyCount = compactU16();
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    if (at + 32 > message.length) throw new Error('truncated keys');
    keys.push(bs58.encode(message.slice(at, at + 32)));
    at += 32;
  }
  at += 32; // recent blockhash
  const instructionCount = compactU16();
  const programs = new Set<string>();
  for (let i = 0; i < instructionCount; i++) {
    const index = byte();
    if (index >= keys.length) throw new Error('program id is not a static account key');
    programs.add(keys[index]);
    const accounts = compactU16();
    at += accounts;
    const dataLength = compactU16();
    at += dataLength;
    if (at > message.length) throw new Error('truncated instruction');
  }
  return [...programs];
}

/** Refuse a Solana transaction that invokes a program the consent does not name. */
export function assertSolanaTransactionInScope(message: Uint8Array, scope: ConsentScope): void {
  if (!scope.allowedContracts || scope.allowedContracts.length === 0) {
    throw new ConsentScopeRejection('This consent does not name any programs, so it does not cover signing transactions');
  }
  let programs: string[];
  try {
    programs = solanaProgramIds(message);
  } catch (err) {
    throw new ConsentScopeRejection(`Transaction message could not be read: ${(err as Error).message}`);
  }
  const outside = programs.filter((p) => !scope.allowedContracts!.includes(p));
  if (outside.length > 0) {
    throw new ConsentScopeRejection(`Programs not covered by this consent: ${outside.join(', ')}`);
  }
}
