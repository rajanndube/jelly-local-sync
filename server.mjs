#!/usr/bin/env node
//
// Jelly Local Sync, zero-dep local server + browser viewer.
//
// Browse to http://localhost:7777, copy the per-session URL the page shows,
// paste it into the Jelly SDK's endpoint setting on phone (or web). Annotations
// POSTed by the SDK stream into the page over SSE. Nothing leaves the machine.
//
// Each GET / issues a fresh, unguessable token. The token is also the API
// namespace prefix (/r/<token>/...), only clients that know the token can
// post or read. Refresh = new token. Old room remains in memory until the
// process exits but is unreachable without the URL.
//
// The HTTP shape under /r/<token>/... mirrors the existing Jelly /sessions
// contract (see jelly/.../sync/JellyApi.kt) so the SDK works unmodified.
// Image upload (POST /annotations/:id/image, binary body) is the one
// extension, the SDK uploads the baked PNG so the browser can render it.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { initClickup, handleClickup } from './clickup.mjs';

const PORT = parseInt(process.env.PORT ?? '7777', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-token state. Each "room" is one browser tab's stream.
//   sessions:   Map<sessionId, Session>          created lazily by SDK
//   annotations: Annotation[]                    flat list, newest last
//   images:     Map<annotationId, {ct, bytes}>   baked PNGs from SDK
//   sse:        Set<ServerResponse>              live page listeners
//   devices:    Map<deviceKey, DeviceInfo>       every SDK that has hello'd
//
// Multiple devices can point at the same URL/token (paste it into several
// phones), so a room tracks a SET of devices, not one. Devices are keyed by
// client IP, the only stable per-device discriminator on the wire, since the
// SDK's /hello body carries no device id. The same key is stamped onto every
// annotation (by the IP its POST arrived on), which is how the page attributes
// an annotation to the device that sent it. Limitation: multiple devices
// tunnelling over `adb reverse` to one host port all share 127.0.0.1 and can't
// be told apart, the multi-device case that works cleanly is several phones on
// Wi-Fi, each with its own LAN IP.
const rooms = new Map();

function newToken() {
  return randomBytes(8).toString('hex'); // 64-bit, fine for local capability
}

function getRoom(token, create = false) {
  let r = rooms.get(token);
  if (!r && create) {
    r = {
      sessions: new Map(),
      annotations: [],
      images: new Map(),
      sse: new Set(),
      devices: new Map(),
    };
    rooms.set(token, r);
  }
  return r;
}

// The "current" session token. Unlike the old behaviour (every GET / minted a
// fresh token, so a browser refresh silently abandoned the room and looked like
// data loss), the server now holds one active session token and serves it on
// every GET /. A refresh therefore re-joins the same room and the feed survives.
// A new session is created only deliberately — POST /session/new — or implicitly
// by restarting the process (memory is wiped, a fresh token is minted on first
// visit). It's minted lazily on first GET / so we don't reserve a room nobody
// opened.
let currentToken = null;
function activeToken() {
  if (!currentToken) { currentToken = newToken(); getRoom(currentToken, true); }
  return currentToken;
}
// Abandon the current session and start a fresh one. The previous room (with its
// annotations + buffered images) is dropped so memory doesn't grow per click and
// the new session truly starts empty.
function rotateSession() {
  if (currentToken) rooms.delete(currentToken);
  currentToken = newToken();
  getRoom(currentToken, true);
  return currentToken;
}

// Stable per-device key for this room. The SDK sends no device id, so we use
// the client IP, distinct per phone on a LAN. Normalise the IPv4-mapped IPv6
// form (::ffff:192.168.1.5) and loopback so the same device hashes the same way
// whether it reaches us over v4 or v6.
function clientKey(req) {
  let a = req.socket?.remoteAddress ?? 'unknown';
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1') a = '127.0.0.1';
  return a;
}

// Register/refresh the device behind this request and return it. Annotations
// can arrive before the first /hello on a cold start; in that case we mint a
// placeholder device (no descriptor yet, lastHelloMs null) so the annotation
// still has a home in the device list and gets re-labelled once /hello lands.
function touchDevice(room, key, body, now) {
  const existing = room.devices.get(key);
  const device = {
    key,
    platform: body?.platform ?? existing?.platform ?? 'unknown',
    model: body?.model ?? existing?.model ?? null,
    manufacturer: body?.manufacturer ?? existing?.manufacturer ?? null,
    osVersion: body?.osVersion ?? existing?.osVersion ?? null,
    appName: body?.appName ?? existing?.appName ?? null,
    sdkVersion: body?.sdkVersion ?? existing?.sdkVersion ?? null,
    firstSeenMs: existing?.firstSeenMs ?? now,
    // null marks "seen via an annotation but never heartbeat", the page shows
    // it without a live pulse. A real /hello passes the body and stamps a time.
    lastHelloMs: body ? now : (existing?.lastHelloMs ?? null),
  };
  room.devices.set(key, device);
  return device;
}

// Rank candidate LAN IPv4 addresses so the QR (and the paste-URL) advertise an
// address the phone can actually reach. The naive "first non-internal IPv4"
// loses on machines where a VPN tunnel (utun/tun/ppp/wg), a Docker bridge
// (172.17.x), or a VM host-only adapter (vboxnet/vmnet) is enumerated *before*
// the real Wi-Fi/Ethernet interface, the QR then encodes a dead address and
// scanning silently fails. We score every candidate by interface name + address
// range and return them best-first; the page receives the full ranked list so
// the user can switch if the auto-pick is still wrong on their network.
const VIRTUAL_IFACE_RE = /^(utun|tun|tap|ppp|ipsec|wg|gpd|docker|veth|br-|bridge|vboxnet|vmnet|vmware|vnic|virbr|llw|awdl|gif|stf|anpi|ap\d)/i;
const PHYSICAL_IFACE_RE = /^(en|eth|wlan|wlp|enp|eno|wl|wifi)/i;

function scoreCandidate(name, address) {
  let score = 0;
  if (PHYSICAL_IFACE_RE.test(name)) score += 100;
  if (VIRTUAL_IFACE_RE.test(name)) score -= 200;
  // Address range, phones share one of these private ranges with the laptop,
  // in rough order of how commonly a phone/laptop network uses them.
  if (address.startsWith('192.168.')) score += 50;
  else if (/^10\./.test(address)) score += 40;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) {
    score += 30;
    if (address.startsWith('172.17.')) score -= 60; // Docker's default bridge subnet
  } else if (address.startsWith('169.254.')) score -= 100; // link-local, unroutable
  else score -= 50; // public-ish / unexpected, almost never the shared LAN
  return score;
}

// All non-internal IPv4 candidates, best-first. Stable order within equal score
// preserves OS enumeration so the result is deterministic.
function lanCandidates() {
  const out = [];
  for (const [name, ifs] of Object.entries(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      out.push({ name, address: i.address, score: scoreCandidate(name, i.address) });
    }
  }
  return out
    .map((c, i) => ({ ...c, order: i }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ name, address }) => ({ name, address }));
}

function lanIp() {
  return lanCandidates()[0]?.address ?? null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const isString = typeof body === 'string';
  const payload = isBuffer ? body : isString ? body : JSON.stringify(body ?? null);
  const contentType =
    headers['content-type'] ??
    (isBuffer ? 'application/octet-stream' : isString ? 'text/plain; charset=utf-8' : 'application/json');
  res.writeHead(status, { ...CORS, 'content-type': contentType, ...headers });
  res.end(payload);
}

// Size caps: prevent a buggy/malicious client from OOMing the server by
// streaming an unbounded body. JSON bodies (annotation payloads, /hello info)
// are tiny, 256 KB is huge headroom. Images cap at 25 MB which covers a 4K
// baked WebP comfortably.
const JSON_BODY_CAP = 256 * 1024;
const IMAGE_BODY_CAP = 25 * 1024 * 1024;

// Reads the request body up to `cap` bytes. Throws PayloadTooLargeError if the
// stream exceeds the cap. We *pause* the stream rather than destroying it so
// the response socket (shared with the request socket) is still writable,// the global handler needs to send a 413 back, then `res.end()` closes
// cleanly. Throwing without pausing would leak memory while we keep
// accumulating chunks for nothing.
class PayloadTooLargeError extends Error {
  constructor(cap) { super(`payload exceeds ${cap} bytes`); this.cap = cap; }
}
async function readWithCap(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > cap) {
      req.pause();
      req.removeAllListeners('data');
      throw new PayloadTooLargeError(cap);
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readWithCap(req, JSON_BODY_CAP);
  if (!buf.length) return null;
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    return null;
  }
}

async function readBuffer(req) {
  return readWithCap(req, IMAGE_BODY_CAP);
}

function broadcast(room, type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  // Snapshot the listener set before iterating. A listener disconnecting
  // mid-broadcast mutates `room.sse` from the req.on('close') handler; iterating
  // the live Set would skip neighbours in some engines and is a race anyway.
  // Cheap (one tiny array copy per event) and correct.
  for (const res of [...room.sse]) {
    try { res.write(payload); } catch { /* listener gone */ }
  }
}

// Whitelisted image MIME types for upload + serve. Anything else falls back
// to image/png so the browser can't be tricked into rendering arbitrary
// MIME-confused content from the cache (the server is local, but cheap to do).
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/webp', 'image/jpeg']);

// Annotation IDs are echoed into SSE event payloads. A malicious ID containing
// `\n` could split the SSE frame and inject a fake `event:` line. Constrain
// to a conservative shape, UUIDs, hex strings, and short slugs all fit.
const ANNOTATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const m = url.pathname;

    if (req.method === 'OPTIONS') return send(res, 204, '');

    // Index, served as a static page that knows its own session token. Serves
    // the *current* session token (not a fresh one) so a browser refresh
    // re-joins the same room and the feed survives. A new session comes only
    // from POST /session/new or a process restart.
    if (m === '/' && req.method === 'GET') {
      const token = activeToken();
      const html = await readFile(path.join(__dirname, 'public', 'index.html'), 'utf-8');
      const cands = lanCandidates();
      const lan = cands[0]?.address ?? null;
      const filled = html
        .replaceAll('__TOKEN__', token)
        .replaceAll('__PORT__', String(PORT))
        .replaceAll('__HOST__', HOST)
        .replaceAll('__LAN_IP__', lan ?? '')
        // JSON array literal injected into a JS context, ranked candidates,
        // best first, each `{ip, iface}`. Lets the page show an explicit
        // address picker (with interface names) when the auto-pick can't be
        // reached by the phone.
        .replaceAll('__LAN_IPS__', JSON.stringify(cands.map((c) => ({ ip: c.address, iface: c.name }))));
      return send(res, 200, filled, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
    }

    // Static assets shipped alongside the page. Whitelist by exact filename so
    // the path-traversal surface is zero. The vendored qrcode.js only changes on
    // a release, so it's cached hard; app.css/app.js are our own source split out
    // of index.html and change often, so they're served no-store (a refresh
    // always reflects the latest edit, matching the no-build-step workflow).
    const STATIC_ASSETS = {
      '/qrcode.js': { ct: 'application/javascript; charset=utf-8', cache: 'public, max-age=3600' },
      '/app.js': { ct: 'application/javascript; charset=utf-8', cache: 'no-store' },
      '/app.css': { ct: 'text/css; charset=utf-8', cache: 'no-store' },
    };
    if (req.method === 'GET' && STATIC_ASSETS[m]) {
      const { ct, cache } = STATIC_ASSETS[m];
      const file = await readFile(path.join(__dirname, 'public', m.slice(1)), 'utf-8');
      return send(res, 200, file, { 'content-type': ct, 'cache-control': cache });
    }

    // Start a fresh session: rotate the current token and drop the old room.
    // Process-global (like /clickup/*), the page reloads after this so GET /
    // hands it the new token. The previously connected devices must re-scan or
    // re-paste the new session URL.
    if (m === '/session/new' && req.method === 'POST') {
      const token = rotateSession();
      return send(res, 200, { token });
    }

    // ClickUp integration routes (process-global, /clickup/*). Self-contained
    // in clickup.mjs; returns true once it has owned the response.
    if (await handleClickup(req, res, url, { send, readJson, rooms, port: PORT })) return;

    // Liveness probe used by the phone-side troubleshooter (public/diag.html)
    // to test whether a given LAN address is reachable. Token-agnostic and
    // tiny, the phone fetches http://<candidate-ip>:<port>/ping for each
    // detected interface; CORS (set by send()) lets it probe cross-origin.
    if (m === '/ping' && req.method === 'GET') {
      return send(res, 200, { ok: true, serverNow: Date.now() });
    }

    // Phone-side diagnostic page. Opened by scanning the QR the dashboard's
    // troubleshooter shows. Templated with the token (so it can report back),
    // the port, and the ranked candidate addresses to probe. Whichever address
    // the phone loaded this page from is, by definition, reachable, the page
    // then probes the rest and POSTs results to /r/:token/diag.
    if (m === '/diag' && req.method === 'GET') {
      const token = (url.searchParams.get('t') ?? '').replace(/[^a-f0-9]/g, '');
      const cands = lanCandidates();
      const diag = await readFile(path.join(__dirname, 'public', 'diag.html'), 'utf-8');
      const filled = diag
        .replaceAll('__TOKEN__', token)
        .replaceAll('__PORT__', String(PORT))
        .replaceAll('__LOADED_FROM__', req.headers.host ?? '')
        .replaceAll('__CANDIDATES__', JSON.stringify(cands.map((c) => ({ ip: c.address, iface: c.name }))));
      return send(res, 200, filled, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
    }

    // Everything else lives under /r/:token/...
    const pm = m.match(/^\/r\/([a-f0-9]+)(\/.*)?$/);
    if (!pm) return send(res, 404, { error: 'not found' });

    const token = pm[1];
    const rest = pm[2] ?? '/';
    const room = getRoom(token, true);

    // SSE, page subscribes here, replays existing annotations on connect.
    if (rest === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        ...CORS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 2000\n\n`);
      // Include serverNow so the page can compute device-liveness with no clock-skew
      // assumption, it diffs lastHelloMs against serverNow, then anchors to its own Date.now().
      res.write(`event: hello\ndata: ${JSON.stringify({
        token,
        count: room.annotations.length,
        devices: [...room.devices.values()],
        serverNow: Date.now(),
      })}\n\n`);
      for (const a of room.annotations) {
        res.write(`event: annotation\ndata: ${JSON.stringify(a)}\n\n`);
        // Re-advertise any buffered screenshot so a freshly-loaded page (e.g.
        // after a refresh, now that the session persists) knows the image
        // exists and renders <img> instead of the "No screenshot" placeholder.
        // The bytes never leave the server in SSE; the page fetches them via
        // GET /annotations/:id/image once it sees this event.
        if (room.images.has(a.id)) {
          res.write(`event: image\ndata: ${JSON.stringify({ id: a.id })}\n\n`);
        }
      }
      room.sse.add(res);
      const ka = setInterval(() => {
        try { res.write(`: keepalive\n\n`); } catch {}
      }, 25_000);
      req.on('close', () => {
        clearInterval(ka);
        room.sse.delete(res);
      });
      return;
    }

    // /hello, SDK identifies itself and heartbeats. Body shape:
    //   { platform, model, manufacturer, osVersion, appName, sdkVersion }
    // Keyed by client IP so several phones pointed at the same URL each register
    // as a distinct device. Each call refreshes that device's lastHelloMs so the
    // page can show per-device "connected / last seen Xs ago" liveness.
    if (rest === '/hello' && req.method === 'POST') {
      const body = (await readJson(req)) ?? {};
      const now = Date.now();
      const device = touchDevice(room, clientKey(req), body, now);
      broadcast(room, 'device', { device, serverNow: now });
      return send(res, 200, { ok: true });
    }

    // Diagnostic report relay. The phone-side /diag page POSTs which candidate
    // addresses it could reach; we relay it to the dashboard over SSE (the only
    // path between the two, they're different clients). Body:
    //   { loadedFrom, results: [{ip, iface, ok, ms}], ua }
    // clientIp is the source IP the report arrived on, the address the phone
    // actually used to reach us, which the dashboard can cross-check.
    if (rest === '/diag' && req.method === 'POST') {
      const report = (await readJson(req)) ?? {};
      broadcast(room, 'diag', { report, clientIp: clientKey(req), serverNow: Date.now() });
      return send(res, 200, { ok: true });
    }

    // /sessions, minimal MCP-shape so the SDK works unmodified.
    if (rest === '/sessions' && req.method === 'GET') {
      return send(res, 200, [...room.sessions.values()]);
    }
    if (rest === '/sessions' && req.method === 'POST') {
      const body = (await readJson(req)) ?? {};
      const id = randomBytes(6).toString('hex');
      // `status` is required by the Android SDK's strict kotlinx Session
      // decode, omit it and createSession() throws MissingFieldException,
      // which runCatching swallows and surfaces as "couldn't reach endpoint".
      // Match the cross-client contract: active/approved/closed.
      const session = {
        id,
        url: body.url ?? '',
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      room.sessions.set(id, session);
      return send(res, 200, session);
    }

    let mm;
    if ((mm = rest.match(/^\/sessions\/([^/]+)$/)) && req.method === 'GET') {
      const sid = mm[1];
      const sess = room.sessions.get(sid);
      if (!sess) return send(res, 404, { error: 'not found' });
      const annotations = room.annotations.filter((a) => a.sessionId === sid);
      return send(res, 200, { ...sess, annotations });
    }

    if ((mm = rest.match(/^\/sessions\/([^/]+)\/annotations$/)) && req.method === 'POST') {
      const sid = mm[1];
      const a = await readJson(req);
      if (!a?.id) return send(res, 400, { error: 'missing id' });
      if (typeof a.id !== 'string' || !ANNOTATION_ID_RE.test(a.id)) {
        return send(res, 400, { error: 'invalid id format' });
      }
      // Attribute the annotation to whichever device's IP it arrived from. If we
      // haven't seen a /hello from that IP yet, mint a placeholder device and
      // announce it so the page's device list and filters stay consistent.
      const key = clientKey(req);
      const existed = room.devices.has(key);
      const device = touchDevice(room, key, null, Date.now());
      if (!existed) broadcast(room, 'device', { device, serverNow: Date.now() });
      const stamped = {
        ...a,
        sessionId: sid,
        createdAt: a.createdAt ?? new Date().toISOString(),
        // Device attribution (server-added; underscore-prefixed to stay out of
        // the SDK's annotation schema). _deviceKey joins to the device list;
        // _device is a denormalised snapshot so the page can label/colour the
        // card even before it has processed that device's SSE event.
        _deviceKey: key,
        _device: {
          key: device.key,
          platform: device.platform,
          model: device.model,
          manufacturer: device.manufacturer,
          osVersion: device.osVersion,
        },
      };
      const idx = room.annotations.findIndex((x) => x.id === stamped.id);
      if (idx >= 0) room.annotations[idx] = stamped;
      else room.annotations.push(stamped);
      broadcast(room, 'annotation', stamped);
      return send(res, 200, stamped);
    }

    if ((mm = rest.match(/^\/annotations\/([^/]+)$/)) && req.method === 'PATCH') {
      const aid = mm[1];
      const patch = (await readJson(req)) ?? {};
      const idx = room.annotations.findIndex((x) => x.id === aid);
      if (idx < 0) return send(res, 404, { error: 'not found' });
      const merged = {
        ...room.annotations[idx],
        ...patch,
        id: aid,
        updatedAt: new Date().toISOString(),
      };
      room.annotations[idx] = merged;
      broadcast(room, 'annotation', merged);
      return send(res, 200, merged);
    }

    if ((mm = rest.match(/^\/annotations\/([^/]+)$/)) && req.method === 'DELETE') {
      const aid = mm[1];
      room.annotations = room.annotations.filter((x) => x.id !== aid);
      room.images.delete(aid);
      broadcast(room, 'delete', { id: aid });
      return send(res, 200, { ok: true });
    }

    // Bulk clear, fired by the page's "Delete all" button. Single SSE event so
    // listeners don't get a flood of per-id 'delete' events on a big purge.
    if (rest === '/annotations' && req.method === 'DELETE') {
      const n = room.annotations.length;
      room.annotations = [];
      room.images.clear();
      broadcast(room, 'clear', { count: n });
      return send(res, 200, { ok: true, deleted: n });
    }

    if ((mm = rest.match(/^\/sessions\/([^/]+)\/action$/)) && req.method === 'POST') {
      return send(res, 200, {
        success: true,
        annotationCount: room.annotations.length,
        delivered: { sseListeners: room.sse.size, webhooks: 0, total: room.sse.size },
      });
    }

    // Image bytes. SDK POSTs the baked PNG/WebP straight as the request body
    // with the file's content-type. Page fetches via GET to render <img>.
    if ((mm = rest.match(/^\/annotations\/([^/]+)\/image$/)) && req.method === 'POST') {
      const aid = mm[1];
      if (!ANNOTATION_ID_RE.test(aid)) return send(res, 400, { error: 'invalid id' });
      const buf = await readBuffer(req);
      if (!buf.length) return send(res, 400, { error: 'empty body' });
      const reqCt = (req.headers['content-type'] ?? 'image/png').split(';')[0].trim();
      // Untrusted MIME types fall back to image/png rather than being stored
      // and re-served as-is. The browser would otherwise render whatever the
      // upload claimed.
      const ct = IMAGE_MIME_WHITELIST.has(reqCt) ? reqCt : 'image/png';
      room.images.set(aid, { ct, bytes: buf });
      broadcast(room, 'image', { id: aid });
      return send(res, 200, { ok: true, size: buf.length });
    }

    if ((mm = rest.match(/^\/annotations\/([^/]+)\/image$/)) && req.method === 'GET') {
      const aid = mm[1];
      const img = room.images.get(aid);
      if (!img) return send(res, 404, { error: 'not found' });
      return send(res, 200, img.bytes, { 'content-type': img.ct, 'cache-control': 'no-store' });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    // PayloadTooLargeError is the one case where the request was at fault
    // (client streaming an oversized body), surface 413 so the SDK can log
    // it clearly rather than retrying a doomed upload. Everything else maps
    // to a generic 500 with the actual exception logged server-side only,    // raw err.message can include internal paths/library noise we don't want
    // any client (or random web page) to see.
    if (err instanceof PayloadTooLargeError) {
      console.warn('[jelly-local-sync]', err.message);
      if (!res.headersSent) send(res, 413, { error: 'payload too large' });
      return;
    }
    console.error('[jelly-local-sync] handler error:', err);
    if (!res.headersSent) send(res, 500, { error: 'internal server error' });
    else try { res.end(); } catch {}
  }
});

// A busy port (another instance still running, or one suspended with Ctrl-Z and
// still holding the socket) would otherwise surface as an unhandled 'error'
// event and dump a stack trace. Translate the common cases into a one-line hint
// and exit cleanly; rethrow anything unexpected.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use, another server (perhaps a suspended` +
      `\n  Jelly Local Sync) is holding it. Stop it, or pick another port:\n` +
      `\n      PORT=${PORT + 1} npx jelly-local-sync\n`
    );
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n  No permission to bind port ${PORT}. Use a port ≥ 1024, e.g. PORT=7777.\n`);
    process.exit(1);
  }
  throw err;
});

// Restore any persisted ClickUp connection before we start accepting requests.
await initClickup();

const HOME_URL = `http://localhost:${PORT}`;
// Interactive only when we own a real terminal on both ends. Piped/CI runs skip
// the hotkeys and rely on the SIGINT/SIGTERM handlers below for a clean exit.
const INTERACTIVE = process.stdin.isTTY && process.stdout.isTTY;

server.listen(PORT, HOST, () => {
  const cands = lanCandidates();
  const [primary, ...alts] = cands;
  const lines = [
    '',
    '  Jelly Local Sync',
    '  ────────────────',
    `  Open in browser:  ${HOME_URL}`,
    primary ? `                    http://${primary.address}:${PORT}  (LAN, for iOS over Wi-Fi)` : '',
    // Show the runners-up so a user whose phone can't reach the auto-picked
    // address can spot the right interface without guessing.
    ...alts.map((c) => `                    http://${c.address}:${PORT}  (also detected: ${c.name})`),
    '',
    '  The page shows a per-session URL, paste that into the Jelly SDK',
    '  endpoint setting on your device. Refresh the page for a fresh',
    '  isolated session.',
    // Hotkey hint only when there's an interactive terminal to read them.
    INTERACTIVE && '  Press o to open the dashboard, Ctrl+C twice to quit.',
  ].filter(Boolean);
  console.log(lines.join('\n'));
  if (autoOpenAllowed()) doOpen(HOME_URL);
  startInteractive();
});

// Open the dashboard in the default browser. Best-effort, fire-and-forget: a
// failure (headless box, no GUI) is silent, the printed URL is the fallback.
function doOpen(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'cmd'
            : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser / no GUI, printed URL is the fallback */ }
}

// Auto-open on launch keeps the "run the command, scan the QR" UX. Skipped when
// stdout isn't a TTY (piped/CI) or when opted out via `--no-open` / `NO_OPEN=1`
// (e.g. adb-reverse / remote setups that don't want a local tab popping up). The
// `o` hotkey opens regardless, since that's an explicit request.
function autoOpenAllowed() {
  if (process.argv.includes('--no-open') || process.env.NO_OPEN) return false;
  return process.stdout.isTTY;
}

// Raw-mode keypress handling. Putting the terminal in raw mode is what lets us
// read single keys (o) without Enter, and, crucially, it stops the terminal
// from turning Ctrl+Z into a SIGTSTP suspend, which is the footgun that strands
// the port (a suspended process keeps the socket bound). In raw mode Ctrl+C and
// Ctrl+Z arrive as bytes (\x03 / \x1a) for us to handle.
const ARM_SECONDS = 5;
let quitArmed = false;
let quitTicker = null;     // per-second countdown interval while armed
let quitRemaining = 0;

function startInteractive() {
  if (!INTERACTIVE) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKey);
}

function onKey(key) {
  if (key === '\u0003') return armOrQuit();   // Ctrl+C
  if (key === '\u001a') {                      // Ctrl+Z (would otherwise suspend + strand the port)
    process.stdout.write('\n  Ctrl+Z is disabled here (it would strand the port). Press Ctrl+C twice to quit.\n');
    return;
  }
  if (key.toLowerCase() === 'o') doOpen(HOME_URL);
}

// First Ctrl+C arms and shows a live countdown; a second Ctrl+C within the
// window quits (shutdown frees the port). When the countdown hits zero the arm
// resets, so one reflexive Ctrl+C earlier in the session can't make a
// much-later single press quit unexpectedly.
function armOrQuit() {
  if (quitArmed) return shutdown();
  quitArmed = true;
  quitRemaining = ARM_SECONDS;
  process.stdout.write('\n');
  renderCountdown();
  clearInterval(quitTicker);
  quitTicker = setInterval(() => {
    quitRemaining -= 1;
    if (quitRemaining <= 0) disarm();
    else renderCountdown();
  }, 1000);
  quitTicker.unref?.();
}

// Rewrite the countdown line in place: \r returns to column 0, \u001b[K clears
// to end of line so the previous number doesn't linger.
function renderCountdown() {
  process.stdout.write(`\r\u001b[K  Press Ctrl+C again to quit  (${quitRemaining}s)`);
}

function disarm() {
  clearInterval(quitTicker);
  quitTicker = null;
  quitArmed = false;
  process.stdout.write('\r\u001b[K  Quit cancelled, still running.\n');
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(quitTicker);
  if (INTERACTIVE) process.stdout.write('\r\u001b[K');   // wipe any countdown line
  process.stdout.write('\n  Shutting down. Port released.\n');
  // SSE listeners hold sockets open indefinitely, so don't wait on server.close
  // to drain, stop accepting new connections and exit. The OS frees the port
  // on exit, which is the whole point: no stale bind left behind.
  try { server.close(); } catch { /* not listening yet */ }
  process.exit(0);
}

// Non-interactive exits (piped/CI) and external signals still shut down cleanly.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Always hand the terminal back, however we exit.
process.on('exit', () => { try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {} });
