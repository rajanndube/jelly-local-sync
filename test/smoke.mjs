#!/usr/bin/env node
//
// Zero-dependency smoke test. Boots server.mjs on a throwaway port, exercises
// the core wire contract the SDKs depend on, and asserts the response shapes.
// Run with `npm test`. Exits non-zero on the first failed assertion.
//
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');
const PORT = 7788;
// Use 127.0.0.1, not "localhost": on Node 18 fetch resolves "localhost" to IPv6
// ::1 first and does NOT fall back to IPv4 (autoSelectFamily defaults to false
// before Node 20), so it never reaches a 127.0.0.1-bound server. Matching the
// literal bound host dodges the whole DNS dance and works on every version.
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
  console.log(`  ok ${msg}`);
}

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start in time');
}

const child = spawn('node', [SERVER], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NO_OPEN: '1' },
  stdio: 'ignore',
});

let failed = false;
try {
  await waitForServer();

  // GET / serves the templated page and mints a token.
  const pageRes = await fetch(`${BASE}/`);
  ok(pageRes.status === 200, 'GET / returns 200');
  ok(pageRes.headers.get('cache-control') === 'no-store', 'GET / is no-store (token rotates)');
  const page = await pageRes.text();
  const m = page.match(/TOKEN = '([a-f0-9]+)'/);
  ok(m && m[1] && m[1].length >= 16, 'GET / embeds a 64-bit hex token');
  const token = m[1];

  // POST /sessions — Android requires `status` in the response or decode throws.
  const sesRes = await fetch(`${BASE}/r/${token}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'x' }),
  });
  ok(sesRes.status === 200, 'POST /sessions returns 200');
  const ses = await sesRes.json();
  ok(typeof ses.id === 'string', 'session has id');
  ok(typeof ses.url === 'string', 'session has url');
  ok(ses.status === 'active', 'session has status:"active" (Android-required field)');
  ok(typeof ses.createdAt === 'string', 'session has createdAt');

  // POST annotation — server stamps device attribution.
  const annRes = await fetch(`${BASE}/r/${token}/sessions/s1/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'a1', comment: 'smoke test' }),
  });
  ok(annRes.status === 200, 'POST annotation returns 200');
  const ann = await annRes.json();
  ok(ann.id === 'a1', 'annotation id echoed back');
  ok(ann._deviceKey != null, 'annotation stamped with _deviceKey');

  // DELETE one annotation.
  const delRes = await fetch(`${BASE}/r/${token}/annotations/a1`, { method: 'DELETE' });
  ok(delRes.status === 200, 'DELETE annotation returns 200');

  // Oversized JSON body is rejected with 413.
  const big = 'x'.repeat(300 * 1024);
  const bigRes = await fetch(`${BASE}/r/${token}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: big }),
  });
  ok(bigRes.status === 413, 'oversized JSON body rejected with 413');

  // Vendored QR library is served.
  const qrRes = await fetch(`${BASE}/qrcode.js`);
  ok(qrRes.status === 200, 'GET /qrcode.js returns 200');

  console.log(`\n${passed} checks passed.`);
} catch (err) {
  failed = true;
  console.error(`\n${err.message}`);
} finally {
  child.kill('SIGKILL');
}

process.exit(failed ? 1 : 0);
