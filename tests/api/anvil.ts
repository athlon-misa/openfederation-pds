/**
 * A local Ethereum node for tests: Foundry's `anvil`, started on a free port
 * and stopped afterwards.
 *
 * Tests that need a real chain call `findAnvil()` and skip when it returns
 * null, so a machine (or CI runner) without Foundry runs the rest of the suite
 * unchanged. The binary is `ANVIL_BIN` when set, otherwise `anvil` on `PATH`,
 * then Foundry's default install location.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Anvil's first default dev account (mnemonic "test test ... junk"), funded with 10,000 ETH. */
export const ANVIL_DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/** Anvil's default chain id. */
export const ANVIL_CHAIN_ID = 31337;

export interface AnvilNode {
  rpcUrl: string;
  port: number;
  chainId: number;
  /** Mine `blocks` empty blocks (`anvil_mine`). */
  mine(blocks: number): Promise<void>;
  stop(): Promise<void>;
}

/** Path to a runnable anvil binary, or null when Foundry is not installed. */
export function findAnvil(): string | null {
  // An explicit ANVIL_BIN is the only candidate, so pointing it at nothing
  // (ANVIL_BIN=none) is how to run these files the way CI does.
  const candidates = process.env.ANVIL_BIN
    ? [process.env.ANVIL_BIN]
    : ['anvil', join(homedir(), '.foundry', 'bin', 'anvil')];
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** A TCP port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function rpc(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(2000),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Start anvil on `port` (a free one when omitted) with its default funded dev
 * accounts and wait until it answers JSON-RPC.
 */
export async function startAnvil(binary: string, port?: number): Promise<AnvilNode> {
  const listenPort = port ?? await freePort();
  const rpcUrl = `http://127.0.0.1:${listenPort}`;
  const child: ChildProcess = spawn(binary, ['--port', String(listenPort), '--host', '127.0.0.1', '--silent'], {
    stdio: 'ignore',
  });
  let exited = false;
  child.once('exit', () => { exited = true; });

  const deadline = Date.now() + 15_000;
  let chainId: number | null = null;
  while (Date.now() < deadline && !exited) {
    try {
      chainId = Number(BigInt(await rpc(rpcUrl, 'eth_chainId') as string));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (chainId === null) {
    child.kill('SIGKILL');
    throw new Error(`anvil did not start on ${rpcUrl}`);
  }

  return {
    rpcUrl,
    port: listenPort,
    chainId,
    async mine(blocks: number) {
      await rpc(rpcUrl, 'anvil_mine', [`0x${blocks.toString(16)}`]);
    },
    async stop() {
      if (exited) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000).unref();
      });
    },
  };
}
