# Jelly Local Sync

Zero-dependency local server + single-page browser viewer that pairs with the Jelly QA SDKs over USB or LAN. QA opens the dashboard on their laptop, the phone-side SDK posts annotations to a per-session URL, and they stream into the page live. Nothing leaves the machine.

## What this is

Jelly is a cross-platform QA annotation toolkit — long-press any UI element on a phone, capture structured feedback, hand it to an AI coding agent. The SDKs (Android, iOS, web) already speak an MCP-style `/sessions` HTTP contract for syncing. Normally that points at a hosted server. For solo QA work the developer just wants the annotations on their laptop right now so they can paste into Cursor / Claude Code.

This repo is that — a tiny Node server plus the single-page viewer it serves. Implements just enough of the MCP contract for the SDKs to work unmodified, plus three local-only extensions (`POST /hello` for device identity + heartbeat, `POST /annotations/:id/image` for binary screenshot upload, `DELETE /annotations` for browser-side bulk clear).

Sibling repos hold the SDKs:

- Android (Kotlin Compose): `../jelly-android` — see its `CLAUDE.md`
- iOS (SwiftUI): `../jelly-swift` — see its `CLAUDE.md`
- Web: `../jelly` (Next.js)

The wire contract is shared across all four. **Server-side changes here MUST stay backward-compatible with the SDK schemas** — the Android SDK in particular uses strict `kotlinx.serialization` decode, so any field rename or missing-required-field breaks sync silently (`runCatching` swallows the exception). When in doubt, curl the endpoint and confirm the response shape matches the SDK's data class.

## Run

```bash
node server.mjs                  # default PORT=7777, HOST=0.0.0.0
PORT=8080 HOST=127.0.0.1 node server.mjs   # bind strict-localhost
```

Then open `http://localhost:7777` in a browser. The page issues a fresh token on every `GET /` (refresh rotates). The layout is a persistent **left rail + main column**:

- **Left rail** — brand + server-connection dot; a live **Devices** list (one row per connected device: colour swatch, label, live/stale dot, per-device annotation tally; click to filter the feed); and a **Connect a device** button (shown once ≥1 device is paired).
- **Main column** — before any device pairs, a centred **"Scan to connect" hero** (the QR is the hero, paste-URL is the quiet fallback, per-platform setup steps tuck behind a disclosure). Once a device pairs, this flips to the **annotation feed** (newest first) with device **filter chips**, a per-card device tag, per-card Copy/Delete, and bulk Delete-all.

Connecting more devices later opens the same connect panel in a modal. **Multiple devices can point at one URL simultaneously** — each is its own row, and its annotations carry its device tag.

No `npm install` step. Zero runtime deps.

## Architecture (key files)

- `server.mjs` — single-file Node ESM HTTP server (~340 lines). Built-in `http`, `crypto`, `fs`, `os`. Per-token rooms held entirely in memory.
- `public/index.html` — single-page app (HTML + CSS + JS inline). Vanilla JS, no framework. Left rail + main column shell. Connects to SSE, tracks a `Map` of devices, renders QR via the vendored library, handles copy/clipboard/modals.
- `public/qrcode.js` — **VENDORED** Kazuhiko Arase qrcode-generator (~2300 lines, MIT, served as `/qrcode.js`). **Do not replace with a hand-rolled implementation** — we tried once and shipped subtly broken QRs (format-info placement bug). If the vendored file needs updating, copy fresh from `node_modules/qrcode-generator/dist/qrcode.js` (don't add the npm dep — copy the file).
- `package.json` — name, bin field, zero dependencies.

## Wire contract

All API endpoints live under `/r/:token/...`. The token is 64-bit random hex generated fresh per `GET /`. Anyone with the URL has full access (local capability, no other auth).

| Method | Path                                  | Notes |
|--------|---------------------------------------|-------|
| GET    | `/`                                   | Mints a fresh token, serves the templated page (`__TOKEN__`, `__PORT__`, `__LAN_IP__` placeholders replaced). `cache-control: no-store` so refresh always rotates. |
| GET    | `/qrcode.js`                          | Vendored QR library. `cache-control: public, max-age=3600`. |
| GET    | `/r/:token/events`                    | SSE stream. Replays all known devices + existing annotations on connect. Event types: `hello`, `device`, `annotation`, `image`, `delete`, `clear`. 25s keepalive comments. |
| POST   | `/r/:token/hello`                     | Device identity + heartbeat. Body `{platform, model, manufacturer, osVersion, appName, sdkVersion}`. Upserts a device in `room.devices` **keyed by client IP** (the only per-device discriminator on the wire — the body has no device id), refreshes its `lastHelloMs`, broadcasts a `device` SSE event. SDK sends every 12s. |
| GET    | `/r/:token/sessions`                  | Lists sessions in this room. |
| POST   | `/r/:token/sessions`                  | Creates a session, returns `{id, url, status: "active", createdAt}`. **`status` is REQUIRED** in the response — Android's `Session` model marks it non-nullable and decode throws `MissingFieldException` if absent. |
| GET    | `/r/:token/sessions/:sid`             | Session + its annotations. |
| POST   | `/r/:token/sessions/:sid/annotations` | Add or update annotation. Server keys by `id` and overwrites, and **stamps `_deviceKey` + `_device`** (the client IP it arrived from + a snapshot of that device) so the page can attribute it. If no `/hello` has been seen from that IP yet, a placeholder device is minted and a `device` SSE is broadcast first. Broadcasts `annotation` SSE. |
| PATCH  | `/r/:token/annotations/:aid`          | Partial update. Broadcasts `annotation` SSE. |
| DELETE | `/r/:token/annotations/:aid`          | Remove one. Broadcasts `delete` SSE. |
| DELETE | `/r/:token/annotations`               | Bulk clear (browser "Delete all" button). Broadcasts a single `clear` SSE — not N `delete` events. |
| POST   | `/r/:token/sessions/:sid/action`      | Action ack returning `{success, annotationCount, delivered: {sseListeners, webhooks, total}}`. |
| POST   | `/r/:token/annotations/:aid/image`    | Binary screenshot upload. Body = raw image bytes, `Content-Type: image/png` or `image/webp`. Best-effort from the SDK side. |
| GET    | `/r/:token/annotations/:aid/image`    | Image bytes for `<img src>`. |

## Per-token rooms

In-memory only. Restart wipes everything. Each room holds:

```
sessions: Map<sid, Session>
annotations: Annotation[]            // flat list, newest last; each stamped with _deviceKey + _device
images: Map<aid, {ct, bytes}>
sse: Set<ServerResponse>
devices: Map<deviceKey, DeviceInfo>  // every SDK that has hello'd (or posted), keyed by client IP
```

`deviceKey` is the normalised client IP (`clientKey()` strips the `::ffff:` prefix and folds `::1` → `127.0.0.1`). Each device object is `{key, platform, model, manufacturer, osVersion, appName, sdkVersion, firstSeenMs, lastHelloMs}`; `lastHelloMs` is `null` for a device first seen via an annotation rather than a `/hello`. Devices are never removed within a session (they go stale, not gone).

Each `GET /` mints a new token and a new empty room. Old rooms persist in memory until process exit but are unreachable without the URL. There is no GC — fine for a tool that's restarted between sessions.

## Page UI sections (where to look in `public/index.html`)

- **Brand + server dot** — top of the left rail. The dot is green when the SSE stream is connected, amber-pulsing while reconnecting.
- **Devices list** (`renderDevices`) — one `button.device-row` per device: colour swatch (stable palette colour assigned in arrival order via `colorFor`), label (`deviceLabel`), a live/stale dot driven by `lastSeenLocalMs`, and a per-device annotation tally. Click to filter the feed. Empty state is the simplified "Scan your QR code" hint. Per-second `tickDeviceStatuses()` updates the status text **in place** (no rebuild, so the live-dot pulse doesn't restart).
- **Connect panel** (`buildConnectPanel` + `CP_HTML`) — the QR-first "point your phone here" experience. Rendered as the **main-column hero** when no device has paired (`syncMainView`), and into a **modal** via the rail's "Connect a device" button afterwards. QR via `drawQR`; when no LAN IP, a greyed placeholder is shown and paste-URL becomes primary. Per-platform steps are a nested `<details>`.
- **Filter chips** (`renderFilters`) — "All devices" + one chip per device, shown only when ≥2 devices exist.
- **Annotation feed** (`render` / `renderCard`) — newest first, filtered by `filterKey`. Each card leads with a device tag (coloured dot + label + platform), then image, comment, intent/severity/kind badges, metadata, and per-card actions (Copy markdown/comment/image, Open, Delete). Only **genuinely new** cards animate (tracked via `renderedIds`) so a re-render on filter/update doesn't replay the whole list. "Delete all" sits in the feed header.
- **Generic confirmation modal** — Promise-based `showConfirm({title, body, confirmText, danger})`. Cancel auto-focuses on `danger: true`.

JS lives at the bottom of `index.html` inside an IIFE — no modules, no build step. Server-templated globals are `TOKEN`, `PORT`, `LAN_IP` at the top of the IIFE.

## SSE event types (server → page)

- `hello` — sent once when a listener connects. Payload `{token, count, devices: DeviceInfo[], serverNow}`. The page anchors each device's age against its own clock using `serverNow - device.lastHelloMs` to dodge clock skew, then ticks `Date.now()` from there.
- `device` — sent on every `/hello` POST (and once when an annotation mints a new placeholder device). Payload `{device, serverNow}`. The page upserts it into the device `Map` by `device.key`.
- `annotation` — sent on every annotation POST/PATCH. Full annotation object, including the server-stamped `_deviceKey` + `_device`.
- `image` — sent after an image upload. Payload `{id}`. The page re-renders only the affected card and updates its `<img src>`.
- `delete` — single removal. Payload `{id}`.
- `clear` — bulk removal. Payload `{count}`. Page wipes all local state.

## Platform caveats

### Android needs cleartext HTTP

Android 9+ (API 28) blocks `http://` at the OkHttp socket layer by default. The SDK's sync calls return success-with-no-body and `runCatching` swallows the failure silently — visible to the user only as "couldn't reach endpoint" from the manual-sync button. Host apps must declare:

```xml
<application android:usesCleartextTraffic="true" ...>
```

(In debug builds only. Production hosts can scope this to `src/debug/AndroidManifest.xml` with `tools:replace`.)

### iOS is Wi-Fi-only for pairing

iOS has no working cable-mode pairing path. `iproxy` from libimobiledevice forwards Mac→Device (what Charles/Proxyman use), not Device→Mac. There's no standard tool that routes the iOS device's `localhost` requests back to the laptop server.

The QR code on the dashboard therefore **always encodes the LAN URL**, never the localhost URL. A localhost URL in a QR is useless to a phone camera — `localhost` resolves to the phone itself once scanned. Cable-only workflows (Android with `adb reverse`) need the localhost text URL pasted manually.

If `LAN_IP` is null (laptop offline / `HOST=127.0.0.1`), the connect hero shows a **greyed QR placeholder** with a "Connect to Wi-Fi to enable scanning" hint and flips its title to "Paste to connect" — the endpoint URL becomes the primary path.

### Device attribution is by client IP

Annotations carry no device id on the wire, and `/hello` carries none either — so the server attributes each annotation to the device by the **client IP** the request arrived from (`clientKey`). On a LAN, every phone has its own IP, so multi-device QA over Wi-Fi tags cleanly. **Caveat:** several devices tunnelling over `adb reverse` to the same host port all present as `127.0.0.1` and collapse into one device row. There's no fix without an SDK change (a per-device id in `/hello` or the annotation body). Document, don't paper over.

### Corporate MDMs

MDMs that block local-network traffic break Wi-Fi pairing for both platforms. Android with `adb reverse` + USB debugging still works (the tunnel is below the IP layer, the MDM never sees it). iOS has no workaround in MDM-locked environments — this is a hard limitation.

## Cross-client parity

The `Annotation` schema and the `OutputGenerator` markdown contract live in the SDK repos, NOT here. The server is pure transport — it does no decoding or validation of annotation payloads beyond requiring an `id`. When adding a field to the annotation shape, update all three SDKs and verify the server passes it through transparently.

The only contract this server enforces is the `Session` response shape (must include `status`, `id`, `url`, `createdAt`) and the `/hello` body shape it stores. Everything else is opaque.

## Debugging tips

- **"couldn't reach endpoint — N failed"** from the SDK's manual-sync button: usually a Session decode failure on the Android side, not a network problem. Curl `POST /r/:token/sessions -d '{"url":"x"}'` and verify the response includes `status`. If you change the response shape, restart Node — there's no hot reload.
- **Device shows "Connected" but no annotations stream in**: `/hello` works (no body decode) but `/sessions` POST or `/sessions/:sid/annotations` POST is failing. Check `adb logcat -s JellySync` (the Android SDK logs the underlying exception on every `runCatching` failure since recent versions).
- **QR doesn't scan**: confirm the page detected a LAN IP (`const LAN_IP` near the top of the IIFE is non-empty). If absent, the connect hero shows a greyed placeholder instead of a QR. Otherwise verify in a separate jsQR test (see `git log` for the verification harness used during the encoder switch).
- **Device row says "Last seen Xs ago" but it's still active**: liveness is anchored per device from `serverNow - lastHelloMs` at hello time, then ticked locally. A device only goes stale after `FRESH_MS` (18s) without a `/hello` — longer than the SDK's 12s heartbeat, so a healthy device stays green.
- **Annotations all land under one device row**: expected when devices share an IP (e.g. multiple `adb reverse` tunnels, or NAT) — see "Device attribution is by client IP" above.
- **Browser stuck on "Reconnecting…"**: the server probably restarted. SSE auto-reconnects with the EventSource default retry. If it doesn't, the page-side `es.onerror` sets `sseConnected = false` and `renderServerDot()` shows the amber-pulsing server dot.

## Build / publish

There is no build step. `node server.mjs` runs as-is. To make a release, just push the repo or distribute the three files (`server.mjs`, `public/index.html`, `public/qrcode.js`) along with `package.json`. The `bin` field in `package.json` exposes the binary name `jelly-local-sync` for `npx`.
