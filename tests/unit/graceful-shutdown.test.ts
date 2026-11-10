import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { gracefulShutdown } from '../../src/server/shutdown.js';

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

describe('graceful shutdown', () => {
  it('lets a request that is already running finish, then releases resources', async () => {
    let finish!: () => void;
    let requestSeen!: () => void;
    const seen = new Promise<void>((r) => { requestSeen = r; });
    const server = await listen((_req, res) => {
      requestSeen();
      finish = () => res.end('done');
    });
    const port = (server.address() as AddressInfo).port;

    const response = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await seen;

    const order: string[] = [];
    const shutdown = gracefulShutdown(server, {
      timeoutMs: 5000,
      cleanup: async () => { order.push('cleanup'); },
    });
    // Still in flight: cleanup (closing the database pool) must not have run.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);

    finish();
    expect(await response).toBe('done');
    expect(await shutdown).toBe('clean');
    expect(order).toEqual(['cleanup']);
  });

  it('stops accepting new connections once shutdown begins', async () => {
    const server = await listen((_req, res) => res.end('ok'));
    const port = (server.address() as AddressInfo).port;
    await gracefulShutdown(server, { timeoutMs: 1000, cleanup: async () => undefined });
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('gives up waiting after the timeout and still cleans up', async () => {
    let requestSeen!: () => void;
    const seen = new Promise<void>((r) => { requestSeen = r; });
    const server = await listen(() => { requestSeen(); /* never answers */ });
    const port = (server.address() as AddressInfo).port;
    fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    await seen;
    let cleaned = false;
    const result = await gracefulShutdown(server, { timeoutMs: 100, cleanup: async () => { cleaned = true; } });
    expect(result).toBe('timed-out');
    expect(cleaned).toBe(true);
  });
});
