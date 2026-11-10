import type { Server } from 'http';

export interface ShutdownOptions {
  /** How long to wait for requests already running before giving up on them. */
  timeoutMs: number;
  /** Runs once the requests are done (or abandoned): stop timers, close the database pool. */
  cleanup: () => Promise<void>;
}

/**
 * Stop a server without cutting off work in progress.
 *
 * New connections are refused at once, idle keep-alive connections are closed,
 * and requests already running are allowed to finish. Only then does `cleanup`
 * run. That order is the point: a write is a signed repo commit and several
 * rows, and closing the database pool under a request part-way through it is
 * how a deploy turned into a failed request (or, before commits and their
 * index became one transaction, into a record that could no longer be written).
 *
 * If requests are still running at the timeout they are abandoned, their
 * connections dropped, and cleanup runs anyway: the platform will kill the
 * process shortly after in any case, and a closed pool is better than a
 * severed one.
 */
export async function gracefulShutdown(server: Server, opts: ShutdownOptions): Promise<'clean' | 'timed-out'> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), opts.timeoutMs);
  });

  const outcome = await Promise.race([closed.then(() => 'clean' as const), timedOut]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timed-out') server.closeAllConnections();

  await opts.cleanup();
  return outcome;
}
