# Jelly Local Sync

[![npm version](https://img.shields.io/npm/v/jelly-local-sync.svg)](https://www.npmjs.com/package/jelly-local-sync)
[![CI](https://github.com/rajanndube/jelly-local-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/rajanndube/jelly-local-sync/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/jelly-local-sync.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/jelly-local-sync.svg)](LICENSE)

A zero-dependency local viewer for Jelly QA annotations. Open it in your browser, paste the per-session URL into the SDK on your phone, and annotations stream in over USB or LAN as image + markdown. Nothing leaves the machine.

## Why

The Jelly SDK (Android, iOS, web) already speaks an MCP-style `/sessions` HTTP contract for syncing annotations. Normally that points at a hosted MCP server. For solo QA work you usually just want the annotations on your laptop right now so you can paste them into Cursor or Claude Code. This is that: a tiny local server + a single-page viewer that implements just enough of the contract.

## Quick start

```bash
npx jelly-local-sync
```

That's it, no clone, no install, no dependencies. It starts the server and pops your browser open to the dashboard. The only prerequisite is Node 18+.

Then:

1. Your browser opens to the dashboard automatically (or visit `http://localhost:7777`).
2. **Scan the QR code** with your phone, or copy the **Endpoint URL** the page shows (a one-time per-session URL like `http://localhost:7777/r/<token>`) and paste it into the Jelly SDK's **Endpoint** setting.
3. Toggle **Sync** on, and annotate. The page updates live.

Refresh the page to start a fresh isolated session. The old URL stays in memory until the process exits but no longer surfaces in the UI.

> Running from a clone instead of npm? `node server.mjs` does the same thing.
>
> **No auto-open:** pass `--no-open` (or set `NO_OPEN=1`) to keep a browser tab from popping, useful for `adb reverse` / remote / headless setups. The tab is also skipped automatically when output isn't a terminal (piped/CI).

## Connecting devices

The page itself has tabbed setup steps with copy-pastable commands, open it and follow along. The summary below is for reference.

### Android over USB (cable-only, MDM-safe)

Plug the phone in with USB debugging enabled, then once:

```
adb reverse tcp:7777 tcp:7777
```

The phone's `localhost:7777` now tunnels over the USB transport to your laptop. No Wi-Fi or LAN involved at any layer, works on airplane mode, on a SIM-less device, or under an MDM that blocks all network traffic.

> **Caveat.** Some corporate Android profiles disable USB debugging entirely. If ADB itself is blocked, this path is gone, same as any developer tooling on that device.

### iOS (Wi-Fi only)

iOS has no `adb reverse` equivalent. `iproxy` goes Mac→Device (Charles/Proxyman use this for the opposite direction, Mac inspecting traffic *from* the device), not Device→Mac, so it doesn't help route an iOS app's `localhost` requests to the laptop server.

The pairing path on iOS is:

1. Put the iPhone and the laptop on the same Wi-Fi network.
2. Scan the QR code on the dashboard (which encodes the LAN URL), or paste the LAN URL into the SDK's Endpoint setting manually.
3. iOS may prompt for Local Network permission, grant it.

Corporate MDMs that block local-network traffic will block this path. There is no current workaround for iOS in those environments.

### Wi-Fi alternative for Android (skip `adb reverse`)

If Wi-Fi is available and the phone isn't under an MDM that blocks local-network traffic, you can skip the `adb reverse` step and just scan the QR or paste the LAN URL. The dashboard's QR encodes the LAN URL specifically because that's the only URL a phone camera can resolve.

### Web (Jelly toolbar in a desktop browser)

Same machine, same origin, paste the URL straight in. CORS is open, no tunneling needed.

## What gets synced

Each annotation arrives as JSON over `POST /r/<token>/sessions/<sid>/annotations`, then the SDK uploads the baked screenshot as binary to `POST /r/<token>/annotations/<id>/image`. The page subscribes to `/r/<token>/events` (Server-Sent Events) and renders cards with:

- the baked screenshot (if uploaded)
- the comment
- intent / severity / kind badges
- element + source-file metadata
- buttons to copy markdown, copy the raw comment, or copy the image to clipboard

The SDK also pings `POST /r/<token>/hello` with device info (model, OS version, app name) on connect and every 12 seconds (the dashboard's manual-probe button waits up to 15 seconds for a heartbeat to decide "connected" vs "stale"). The header status line uses this to show e.g. **Pixel 7 · Android 14, Connected** or **Last seen 2m ago** so you can tell at a glance whether the cable is still good.

## ClickUp tickets

Push any annotation straight into ClickUp as a **Task or Bug** — comment as the description, severity mapped to priority, screenshot attached — or use **Create multiple tickets** to file a batch into one list at once.

Connect once from the dashboard (**Connect → ClickUp**):

- **Quickest:** paste a ClickUp **personal API token** (`pk_…`, from ClickUp → Settings → Apps). No app to register.
- **OAuth** (under *Advanced*): register a ClickUp OAuth app once and approve in a popup. The setup form shows the exact redirect URL to use; alternatively set `CLICKUP_CLIENT_ID` / `CLICKUP_CLIENT_SECRET`.

The token/credentials are stored **server-side only** under `~/.jelly-local-sync/` (never in the browser or the repo) and persist across restarts; **Disconnect** clears them. If your workspace has a custom **Bug** task type, the Bug toggle creates a real Bug; otherwise it prefixes the title with 🐞. The first authorized workspace is used.

## Configuration

```bash
PORT=7777 HOST=0.0.0.0 node server.mjs
```

Defaults: `PORT=7777`, `HOST=0.0.0.0` so LAN devices can reach it. Bind to `127.0.0.1` if you want strict localhost-only.

## Wire contract

The HTTP shape under `/r/<token>/...` is a subset of the MCP `/sessions` contract:

| Method | Path                                 | Notes |
|--------|--------------------------------------|-------|
| GET    | `/r/:token/events`                   | SSE: `annotation`, `image`, `delete`, `clear`, `device`, plus replay on connect |
| POST   | `/r/:token/hello`                    | Device identity + heartbeat (broadcasts `device`) |
| GET    | `/r/:token/sessions`                 | List sessions in this room |
| POST   | `/r/:token/sessions`                 | Create session, returns `{id, url, createdAt}` |
| GET    | `/r/:token/sessions/:sid`            | Session with its annotations |
| POST   | `/r/:token/sessions/:sid/annotations`| Add annotation (broadcasts) |
| PATCH  | `/r/:token/annotations/:aid`         | Update (broadcasts) |
| DELETE | `/r/:token/annotations/:aid`         | Remove one (broadcasts `delete`) |
| DELETE | `/r/:token/annotations`              | Remove all in this room (broadcasts `clear`) |
| POST   | `/r/:token/sessions/:sid/action`     | Ack returning listener counts |
| POST   | `/r/:token/annotations/:aid/image`   | Binary image upload (extension) |
| GET    | `/r/:token/annotations/:aid/image`   | Image bytes |

Storage is in-memory and per-token. Restarting the server clears everything.

Per-request body caps: **256 KB** for JSON payloads, **25 MB** for binary image uploads. Oversized bodies are rejected with 413. There is no eviction of in-memory rooms between sessions, a single Node process accumulating thousands of tokens with image uploads will grow forever; the intended lifecycle is "restart between QA sessions", consistent with `npx jelly-local-sync` usage. If you keep one process up for days, restart it periodically.

## Security model

The token is a 64-bit random hex string. Knowing the URL is the only access control, which is fine for a local-network tool. The server defaults to `0.0.0.0` so phones on the same Wi-Fi can reach it; tighten with `HOST=127.0.0.1` if you only need same-machine access.
