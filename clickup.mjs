// Jelly Local Sync, ClickUp integration (process-global, NOT per-room).
//
// One ClickUp connection serves the whole machine, not one browser tab, so the
// OAuth token lives at module scope and survives page refreshes (which rotate
// the room token). OAuth is the only viable path: the dashboard can't call
// ClickUp's API directly (api.clickup.com sends no CORS headers) and can't
// borrow the user's app.clickup.com session (cookies are origin-locked and the
// API rejects them anyway). OAuth lets the user reuse "already logged in"
// without ever pasting a personal token.
//
// Credentials (client id/secret of a ClickUp OAuth app the user registers once)
// resolve in this order: env (CLICKUP_CLIENT_ID / CLICKUP_CLIENT_SECRET) → the
// UI-saved ~/.jelly-local-sync/oauth-app.json (the normal path, written by the
// in-page setup form) → a legacy gitignored clickup-oauth.json next to this
// file. The access token is persisted under ~/.jelly-local-sync too, so a
// server restart keeps the connection. Nothing secret ever lives in the repo.
//
// server.mjs mounts this with a single line in its request handler:
//   if (await handleClickup(req, res, url, { send, readJson, rooms, port })) return;
// and calls initClickup() once at startup. No other coupling, all ClickUp
// state and HTTP shape lives here so it can be debugged in isolation.

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const CLICKUP_AUTHORIZE = 'https://app.clickup.com/api';
const TOKEN_DIR = path.join(homedir(), '.jelly-local-sync');
const TOKEN_FILE = path.join(TOKEN_DIR, 'clickup.json');
// OAuth app credentials (client id/secret) configured via the UI live in the
// user's config dir, NOT the repo, so nothing secret is ever committed.
const APP_FILE = path.join(TOKEN_DIR, 'oauth-app.json');

// In-memory connection state: { access_token, teamId, teamName, teams:[{id,name}] }.
let auth = null;
// Resolved "Bug" custom task-type id for the workspace. undefined = not looked
// up yet, null = workspace has no Bug type (fall back to a name prefix), number
// = the id to pass as custom_item_id so the Bug toggle creates a genuine Bug.
let bugType;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// OAuth app credentials. Resolution order: env (CI / power users) → the
// UI-saved file in the user config dir → a legacy gitignored file next to this
// module. null if the user hasn't set up an app yet (the page then shows the
// in-modal setup form instead of a Connect button).
async function loadApp() {
  const id = process.env.CLICKUP_CLIENT_ID;
  const secret = process.env.CLICKUP_CLIENT_SECRET;
  if (id && secret) return { client_id: id, client_secret: secret };
  for (const file of [APP_FILE, path.join(__dirname, 'clickup-oauth.json')]) {
    try {
      const j = JSON.parse(await readFile(file, 'utf-8'));
      if (j.client_id && j.client_secret) return j;
    } catch { /* try next */ }
  }
  return null;
}

// Persist UI-entered credentials to the user config dir (never the repo).
async function saveApp(client_id, client_secret) {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(APP_FILE, JSON.stringify({ client_id, client_secret }), 'utf-8');
}

async function saveToken(next) {
  auth = next;
  bugType = undefined; // re-resolve against the newly connected workspace
  try {
    await mkdir(TOKEN_DIR, { recursive: true });
    await writeFile(TOKEN_FILE, JSON.stringify(next), 'utf-8');
  } catch (e) {
    console.warn('[jelly-local-sync] could not persist ClickUp token:', e.message);
  }
}

async function clearToken() {
  auth = null;
  bugType = undefined;
  try { await writeFile(TOKEN_FILE, JSON.stringify(null), 'utf-8'); } catch { /* ignore */ }
}

// Thin ClickUp REST helper. Sends the OAuth token raw in Authorization (the v2
// API's long-standing accepted form for both personal and OAuth tokens) and
// normalises failures to a thrown Error carrying the HTTP status.
async function cu(pathname, opts = {}) {
  if (!auth?.access_token) { const e = new Error('not connected'); e.status = 409; throw e; }
  const res = await fetch(CLICKUP_API + pathname, {
    ...opts,
    headers: { Authorization: auth.access_token, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const e = new Error(`clickup ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

// Resolve (and cache) the workspace's "Bug" custom task type so the Bug toggle
// creates a real ClickUp Bug. Workspaces without custom task types return null
// and the caller falls back to a name prefix, so creation never fails.
async function resolveBugType(teamId) {
  if (bugType !== undefined) return bugType;
  try {
    const data = await cu(`/team/${teamId}/custom_item`);
    const items = data?.custom_items ?? [];
    const bug = items.find((i) => /bug/i.test(i.name ?? '') || /bug/i.test(i.name_plural ?? ''));
    bugType = bug ? bug.id : null;
  } catch { bugType = null; }
  return bugType;
}

// Upload an annotation's baked screenshot (already held in room.images) to a
// task as a real ClickUp attachment. Hand-rolled multipart keeps the zero-dep
// promise; undici's fetch accepts a Buffer body directly.
async function attachImage(taskId, annId, img) {
  const boundary = '----jelly' + randomBytes(8).toString('hex');
  const ext = img.ct === 'image/webp' ? 'webp' : img.ct === 'image/jpeg' ? 'jpg' : 'png';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${annId}.${ext}"\r\n` +
    `Content-Type: ${img.ct}\r\n\r\n`, 'utf-8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const res = await fetch(`${CLICKUP_API}/task/${taskId}/attachment`, {
    method: 'POST',
    headers: { Authorization: auth.access_token, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, img.bytes, tail]),
  });
  if (!res.ok) throw new Error('attachment ' + res.status);
}

// Page shown in the OAuth popup after the redirect. Signals the opener (the
// dashboard) over postMessage and self-closes on success.
function callbackHtml(error) {
  const ok = !error;
  return `<!doctype html><html><head><meta charset="utf-8"><title>ClickUp</title></head>` +
    `<body style="font:14px/1.5 system-ui,sans-serif;background:#0b0c0e;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="text-align:center;max-width:380px;padding:24px"><div style="font-size:40px">${ok ? '✅' : '⚠️'}</div>` +
    `<p>${ok ? 'ClickUp connected. You can close this window.' : 'ClickUp connection failed:<br><code style="color:#ff9b9b">' + escapeHtml(error) + '</code>'}</p></div>` +
    `<script>try{window.opener&&window.opener.postMessage({source:'jelly-clickup',ok:${ok}},'*')}catch(e){}` +
    `${ok ? 'setTimeout(function(){window.close()},900);' : ''}</script></body></html>`;
}

// Load any persisted token at startup so a connection survives a restart.
export async function initClickup() {
  try { auth = JSON.parse(await readFile(TOKEN_FILE, 'utf-8')) || null; }
  catch { auth = null; }
}

// Route handler. Returns true if it owned the request (so server.mjs can
// `return`), false if the path isn't a /clickup/* path. ctx = { send, readJson,
// rooms, port }, the few server primitives this module needs.
export async function handleClickup(req, res, url, ctx) {
  const { send, readJson, rooms, port } = ctx;
  const m = url.pathname;
  if (!m.startsWith('/clickup/')) return false;

  const redirectUri = `http://localhost:${port}/clickup/callback`;

  // Connection state for the page: is an OAuth app configured, and are we
  // currently holding a token. Drives the Connect button's label/state.
  if (m === '/clickup/status' && req.method === 'GET') {
    const app = await loadApp();
    send(res, 200, {
      configured: !!app,
      connected: !!auth?.access_token,
      teamName: auth?.teamName ?? null,
      // Surfaced so the setup form can show the exact Redirect URL to register
      // (it must match this port).
      redirectUri,
    });
    return true;
  }

  // Save OAuth app credentials entered in the UI. Stored server-side in the user
  // config dir; the browser never reads them back.
  if (m === '/clickup/config' && req.method === 'POST') {
    const b = (await readJson(req)) ?? {};
    const clientId = (b.client_id || '').trim();
    const clientSecret = (b.client_secret || '').trim();
    if (!clientId || !clientSecret) { send(res, 400, { error: 'client_id and client_secret are required' }); return true; }
    try {
      await saveApp(clientId, clientSecret);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
    return true;
  }

  // Kick off OAuth, 302 to ClickUp's consent screen. Opened in a popup by the
  // page; because the user is already logged in, ClickUp shows one-click Allow.
  if (m === '/clickup/auth' && req.method === 'GET') {
    const app = await loadApp();
    if (!app) { send(res, 400, { error: 'ClickUp OAuth app not configured' }); return true; }
    const u = new URL(CLICKUP_AUTHORIZE);
    u.searchParams.set('client_id', app.client_id);
    u.searchParams.set('redirect_uri', redirectUri);
    res.writeHead(302, { location: u.toString() });
    res.end();
    return true;
  }

  // OAuth redirect target. Exchange the code for an access token, pick the
  // first authorised workspace, persist, and serve the popup-closing page.
  if (m === '/clickup/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const app = await loadApp();
    const htmlHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (!code || !app) { send(res, 200, callbackHtml('missing code or app config'), htmlHeaders); return true; }
    try {
      const tokUrl = new URL(`${CLICKUP_API}/oauth/token`);
      tokUrl.searchParams.set('client_id', app.client_id);
      tokUrl.searchParams.set('client_secret', app.client_secret);
      tokUrl.searchParams.set('code', code);
      const tokRes = await fetch(tokUrl, { method: 'POST' });
      const tok = await tokRes.json().catch(() => ({}));
      if (!tok.access_token) throw new Error(tok.err || 'no access_token in response');
      const teamRes = await fetch(`${CLICKUP_API}/team`, { headers: { Authorization: tok.access_token } });
      const teams = (await teamRes.json().catch(() => ({})))?.teams ?? [];
      const first = teams[0] ?? null;
      await saveToken({
        access_token: tok.access_token,
        teamId: first?.id ?? null,
        teamName: first?.name ?? null,
        teams: teams.map((t) => ({ id: t.id, name: t.name })),
      });
      send(res, 200, callbackHtml(null), htmlHeaders);
    } catch (e) {
      send(res, 200, callbackHtml(e.message), htmlHeaders);
    }
    return true;
  }

  if (m === '/clickup/disconnect' && req.method === 'POST') {
    await clearToken();
    send(res, 200, { ok: true });
    return true;
  }

  // Connect with a personal API token (pk_…), the no-OAuth path. ClickUp's v2
  // API accepts a personal token in the same raw Authorization header cu() uses
  // for OAuth tokens, so we just validate it against /team and persist exactly
  // like the OAuth callback does. No client id/secret, no popup, no app.
  if (m === '/clickup/token' && req.method === 'POST') {
    const b = (await readJson(req)) ?? {};
    const token = (b.token || '').trim();
    if (!token) { send(res, 400, { error: 'token is required' }); return true; }
    try {
      const teamRes = await fetch(`${CLICKUP_API}/team`, { headers: { Authorization: token } });
      if (!teamRes.ok) {
        send(res, teamRes.status === 401 ? 401 : 502,
          { error: teamRes.status === 401 ? 'invalid token' : `clickup ${teamRes.status}` });
        return true;
      }
      const teams = (await teamRes.json().catch(() => ({})))?.teams ?? [];
      if (!teams.length) { send(res, 502, { error: 'token has no workspaces' }); return true; }
      const first = teams[0];
      await saveToken({
        access_token: token,
        teamId: first.id,
        teamName: first.name,
        teams: teams.map((t) => ({ id: t.id, name: t.name })),
      });
      send(res, 200, { ok: true, teamName: first.name });
    } catch (e) {
      send(res, 502, { error: e.message });
    }
    return true;
  }

  // Spaces in the connected workspace, for the first dropdown.
  if (m === '/clickup/spaces' && req.method === 'GET') {
    try {
      if (!auth?.teamId) { send(res, 409, { error: 'not connected' }); return true; }
      const data = await cu(`/team/${auth.teamId}/space?archived=false`);
      send(res, 200, { spaces: (data.spaces ?? []).map((s) => ({ id: s.id, name: s.name })) });
    } catch (e) { send(res, e.status === 401 ? 401 : 502, { error: e.message }); }
    return true;
  }

  // Lists in a space, for the second dropdown. Tasks live in lists, not spaces,
  // so we flatten folder lists (labelled "Folder / List") and folderless lists.
  if (m === '/clickup/lists' && req.method === 'GET') {
    const spaceId = url.searchParams.get('space_id');
    if (!spaceId) { send(res, 400, { error: 'space_id required' }); return true; }
    try {
      // Folder lists and folderless lists are independent reads, fetch in parallel.
      const [folders, folderless] = await Promise.all([
        cu(`/space/${spaceId}/folder?archived=false`),
        cu(`/space/${spaceId}/list?archived=false`),
      ]);
      const lists = [];
      for (const f of folders.folders ?? []) {
        for (const l of f.lists ?? []) lists.push({ id: l.id, name: `${f.name} / ${l.name}` });
      }
      for (const l of folderless.lists ?? []) lists.push({ id: l.id, name: l.name });
      send(res, 200, { lists });
    } catch (e) { send(res, e.status === 401 ? 401 : 502, { error: e.message }); }
    return true;
  }

  // Create a task (or Bug) in the chosen list, prefilled from the annotation,
  // and attach its screenshot if we still hold the bytes for that annotation.
  if (m === '/clickup/task' && req.method === 'POST') {
    const b = (await readJson(req)) ?? {};
    if (!b.list_id || !b.name) { send(res, 400, { error: 'list_id and name required' }); return true; }
    try {
      const payload = { name: b.name, markdown_content: b.markdown ?? b.description ?? '' };
      if (b.priority) payload.priority = b.priority; // 1 urgent .. 4 low
      if (b.type === 'bug') {
        const id = await resolveBugType(auth.teamId);
        if (id != null) payload.custom_item_id = id;
        else payload.name = '🐞 ' + payload.name; // graceful fallback when no Bug type exists
      }
      const task = await cu(`/list/${encodeURIComponent(b.list_id)}/task`, { method: 'POST', body: JSON.stringify(payload) });
      let attached = false;
      if (b.roomToken && b.annotationId) {
        const img = rooms.get(b.roomToken)?.images.get(b.annotationId);
        if (img) {
          try { await attachImage(task.id, b.annotationId, img); attached = true; }
          catch (e) { console.warn('[jelly-local-sync] ClickUp attach failed:', e.message); }
        }
      }
      send(res, 200, { id: task.id, url: task.url ?? `https://app.clickup.com/t/${task.id}`, attached });
    } catch (e) { send(res, e.status === 401 ? 401 : 502, { error: e.message }); }
    return true;
  }

  send(res, 404, { error: 'not found' });
  return true;
}
