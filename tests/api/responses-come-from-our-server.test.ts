/**
 * Every response came from *this* application (#222).
 *
 * The suite used to fail intermittently, on a different test each run, because
 * `request(app)` makes supertest call `app.listen(0)` for **every** request:
 * a full run cycled through thousands of OS-assigned ephemeral ports, in the
 * same 49152–65535 range every other local daemon uses. A captured failure
 * shows an XRPC request answered by `server: CCLibrary/4.18.2` — Adobe Creative
 * Cloud — with `405 MethodNotAllowed`; others arrived as `ECONNRESET` from
 * ports with nothing listening.
 *
 * `helpers.ts` now hands supertest one already-listening server, so there is no
 * port churn to collide. This pins the property that failure violated, because
 * the fix is one line and nothing else would notice it being undone.
 *
 * The check is "the responder is ours", not "the status was expected". A
 * foreign daemon returning 405 announces itself loudly; one returning a
 * plausible 200 would corrupt a test silently, and that is the case a
 * retry-on-error workaround could never have covered.
 */
import { describe, it, expect } from 'vitest';
import { api, xrpcGet } from './helpers.js';

/** Set by our own middleware on every response, before any route runs. */
const OUR_HEADER = 'x-content-type-options';

describe('responses come from our server (#222)', () => {
  it('answers a burst of requests from one address, all ours', async () => {
    // Enough requests that per-request port churn would have been sampling a
    // large slice of the ephemeral range.
    const seenPorts = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const res = await xrpcGet('com.atproto.server.describeServer', {});
      expect(res.headers[OUR_HEADER]).toBeDefined();
      const port = (res as any).req?.socket?.remotePort ?? (res as any).request?.req?.socket?.remotePort;
      if (typeof port === 'number') seenPorts.add(port);
    }

    // One listener for the whole file. If this ever grows with the request
    // count again, the per-request `listen(0)` behaviour is back.
    expect(seenPorts.size).toBeLessThanOrEqual(1);
  }, 60_000);

  it('reaches our app even for a path it does not serve', async () => {
    // A foreign responder is most likely to differ exactly here: our 404 is a
    // JSON XRPC envelope carrying our headers, not somebody else's error page.
    const res = await api.get('/xrpc/net.openfederation.does.not.exist');

    expect(res.status).toBe(404);
    expect(res.headers[OUR_HEADER]).toBeDefined();
    expect(res.body.error).toBe('MethodNotFound');
  });
});
