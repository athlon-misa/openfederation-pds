/**
 * Security Regression Tests: Security Headers & CORS
 *
 * Tests that the Express server sets correct security headers
 * and handles CORS properly. Uses the exported Express app directly
 * with Node's http module — no external test dependencies.
 * Requires no database (hits only the root / endpoint).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Set required env vars before importing config-dependent modules
process.env.AUTH_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.KEY_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

import { app } from '../src/server/index.js';

let server: http.Server;
let baseUrl: string;

function fetch(path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  // Start the app on a random port (avoids conflict with running server)
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
});

describe('Security headers', () => {
  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await fetch('/');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const res = await fetch('/');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  it('sets X-XSS-Protection: 0', async () => {
    const res = await fetch('/');
    assert.equal(res.headers['x-xss-protection'], '0');
  });

  it('sets Referrer-Policy', async () => {
    const res = await fetch('/');
    assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  });

  it('sets Permissions-Policy', async () => {
    const res = await fetch('/');
    assert.ok(res.headers['permissions-policy']?.includes('camera=()'));
    assert.ok(res.headers['permissions-policy']?.includes('microphone=()'));
  });
});

describe('CORS', () => {
  it('sets Access-Control-Allow-Origin for allowed origin', async () => {
    const res = await fetch('/', {
      headers: { origin: 'http://localhost:3001' },
    });
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3001');
  });

  it('does NOT set Access-Control-Allow-Origin for disallowed origin', async () => {
    const res = await fetch('/', {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('responds 204 to OPTIONS preflight', async () => {
    const res = await fetch('/', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3001' },
    });
    assert.equal(res.status, 204);
  });

  it('sets correct Access-Control-Allow-Methods', async () => {
    const res = await fetch('/', {
      headers: { origin: 'http://localhost:3001' },
    });
    const methods = res.headers['access-control-allow-methods'];
    assert.ok(methods?.includes('GET'));
    assert.ok(methods?.includes('POST'));
    assert.ok(methods?.includes('DELETE'));
  });

  it('sets correct Access-Control-Allow-Headers', async () => {
    const res = await fetch('/', {
      headers: { origin: 'http://localhost:3001' },
    });
    const allowedHeaders = res.headers['access-control-allow-headers'];
    assert.ok(allowedHeaders?.includes('Content-Type'));
    assert.ok(allowedHeaders?.includes('Authorization'));
  });
});

describe('XRPC routing security', () => {
  it('returns 404 for unknown XRPC method', async () => {
    const res = await fetch('/xrpc/com.evil.nonexistent');
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'MethodNotFound');
  });

  it('does not leak internal details in 500 error messages', async () => {
    // The root endpoint always succeeds, but the XRPC handler wraps errors
    // with a generic message — verify that pattern exists
    const res = await fetch('/xrpc/com.atproto.repo.getRecord');
    // Even if it errors due to missing params, it should not expose stack traces
    const body = JSON.parse(res.body);
    assert.ok(!body.stack, 'Response should not contain stack traces');
    assert.ok(!body.message?.includes('/'), 'Error message should not contain file paths');
  });
});

describe('Request body size limit', () => {
  it('returns 413 for oversized JSON payloads', async () => {
    const largeBody = JSON.stringify({ data: 'x'.repeat(300 * 1024) }); // ~300kb > 256kb limit
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL('/xrpc/com.atproto.server.createSession', baseUrl);
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(largeBody).toString(),
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.write(largeBody);
      req.end();
    });
    assert.equal(res.status, 413);
  });
});
