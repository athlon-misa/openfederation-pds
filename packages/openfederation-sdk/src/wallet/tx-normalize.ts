/**
 * Convert a user-supplied EVM TransactionRequest into a JSON-safe shape.
 *
 * ethers v6 uses BigInt for value / gasLimit / gas-price fields. JSON can't
 * serialize BigInt directly — we stringify them. Addresses stay as strings,
 * numbers stay as numbers. The server reverses this in normalizeEvmTx
 * (see src/wallet/custody.ts).
 */
export function normalizeEvmTxForWire(tx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bigintKeys = [
    'gasLimit',
    'gasPrice',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'value',
  ];
  for (const [k, v] of Object.entries(tx)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'bigint') {
      out[k] = v.toString();
    } else if (bigintKeys.includes(k) && typeof v === 'number') {
      // Normalize numbers-as-bigints too.
      out[k] = String(v);
    } else {
      out[k] = v as unknown;
    }
  }
  return out;
}
