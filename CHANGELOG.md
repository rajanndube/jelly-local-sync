# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-06-05

### Added
- **ClickUp integration.** Connect by pasting a personal API token (`pk_…`, the
  breezy path — no app to register) or via OAuth (behind "Advanced"). Create a
  ClickUp **Task or Bug** from any annotation — comment as the description,
  severity mapped to priority, screenshot attached — plus a **"Create multiple
  tickets"** bulk flow that tickets every selected annotation into one
  space/list. The ClickUp logo appears throughout, and the footer button shows
  the connected workspace. Self-contained in `clickup.mjs`; setup documented in
  `SETUP_CLICKUP.md`.
- **Session persistence.** A browser refresh now re-joins the same session
  instead of silently starting empty, and buffered screenshots survive the
  reload too (the SSE replay re-advertises them). A confirm-gated **New session**
  button (`POST /session/new`) starts a fresh capture; a server restart also
  resets.

### Changed
- Split the single-file `public/index.html` into `index.html` + `app.css` +
  `app.js` (still zero-build; the page reads server-templated globals from a
  `window.JELLY` bootstrap, and `app.css`/`app.js` are served `no-store`).
- Annotation-card hierarchy: screenshot **Copy/Open** moved onto the image as a
  hover overlay, card button sizes unified, and **Troubleshoot + New session**
  demoted to a quieter tertiary footer row beneath the primary connect buttons.

## [0.3.0] - 2026-06-05

### Added
- Interactive CLI. When run in a terminal, press `o` to (re)open the dashboard
  in the browser. The dashboard still auto-opens on launch as before; `o` is for
  reopening.
- Quit ergonomics: a single Ctrl+C arms and shows a live per-second countdown
  ("Press Ctrl+C again to quit  (5s)"); a second Ctrl+C within the window quits
  and frees the port. If the countdown lapses it disarms ("Quit cancelled, still
  running.") so one reflexive Ctrl+C can't tear down a live QA session.

### Changed
- Ctrl+Z no longer suspends the process. Because the interactive mode puts the
  terminal in raw mode, Ctrl+Z is delivered to us as a keystroke (and ignored
  with a hint) instead of becoming a SIGTSTP suspend, which is what used to
  leave the process alive in the background still holding the port. Piped/CI
  runs (no TTY) keep the old behavior and exit cleanly on SIGINT/SIGTERM.

## [0.2.1] - 2026-06-05

### Fixed
- A busy port no longer dumps an unhandled-error stack trace. `EADDRINUSE`
  (another instance, or one suspended with Ctrl-Z still holding the socket) and
  `EACCES` now print a one-line hint and exit cleanly.

### Changed
- The troubleshooter's firewall guidance now leads with the Android-over-USB
  bypass (`adb reverse` + the localhost endpoint) for MDM-managed firewalls you
  can't change, and is explicit that iOS needs an IT/MDM exception or an
  unmanaged laptop, instead of the dead-end "go change your firewall" advice.
- Removed em dashes from all user-facing text, docs, and code comments (style).

## [0.2.0] - 2026-06-05

### Added
- **Connection troubleshooter**, a sticky "Troubleshoot" button in the left rail
  opens a two-sided connection diagnostic. Laptop-side self-checks cover the LAN
  address, server binding (`HOST`), VPN/virtual-interface noise, SSE health, and
  self-reachability. A phone-side probe (QR → new `/diag` page) then tests every
  detected address from the phone and reports back which ones it can actually
  reach, auto-selecting the working one. Things the laptop can't observe (phone
  Wi-Fi state, MDM policy, Android cleartext) are shown as guidance, not checks.
- Phone-side reachability probe page (`public/diag.html`) and supporting
  endpoints: `GET /ping` (liveness), `GET /diag` (templated probe page), and
  `POST /r/:token/diag` (relays the phone's report to the dashboard over a new
  `diag` SSE event).
- **Address picker** under the connect QR when more than one network interface is
  detected, one selectable row per address, labelled with its interface;
  selecting one re-encodes every QR and LAN URL live.

### Changed
- LAN address detection now **ranks** all candidate interfaces (physical
  Wi-Fi/Ethernet and private 192.168 / 10 / 172 ranges preferred; VPN tunnels,
  Docker bridges, VM adapters, and link-local deprioritised) instead of returning
  the first non-internal IPv4. The dashboard and the startup banner surface the
  full ranked list.

### Fixed
- The QR could encode an unreachable VPN/virtual-adapter address on machines
  where such an interface enumerated before the real Wi-Fi/Ethernet one, the
  "works on my machine, fails everywhere else" pairing failure. The ranking,
  address picker, and phone-side probe together resolve it.

## [0.1.1] - 2026-06-05

### Changed
- Packaging metadata only, no code changes. Added `repository`, `homepage`,
  `bugs`, `keywords`, and `author` to `package.json` so the npm page links back
  to the (now public) GitHub repo. Runtime behavior is identical to 0.1.0.

## [0.1.0] - 2026-06-05

Initial public release.

### Added
- Zero-dependency local server (`server.mjs`) implementing a subset of the Jelly
  MCP-style `/sessions` HTTP contract, so the Android / iOS / web SDKs sync
  unmodified.
- Single-page dashboard (`public/index.html`), left rail with a live Devices
  list, QR-first "Scan to connect" hero, and a live annotation feed over SSE.
- `npx jelly-local-sync` one-liner: starts the server and auto-opens the
  dashboard in the default browser. Opt out with `--no-open` / `NO_OPEN=1`;
  auto-skipped when stdout is not a TTY.
- Local-only contract extensions: `POST /hello` (device identity + heartbeat),
  `POST /annotations/:id/image` (binary screenshot upload), `DELETE /annotations`
  (browser-side bulk clear).
- Per-device attribution by client IP, multi-device support over one URL.
- Request body caps (256 KB JSON, 25 MB image) returning `413` on overflow.

[Unreleased]: https://github.com/rajanndube/jelly-local-sync/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/rajanndube/jelly-local-sync/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rajanndube/jelly-local-sync/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/rajanndube/jelly-local-sync/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rajanndube/jelly-local-sync/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rajanndube/jelly-local-sync/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rajanndube/jelly-local-sync/releases/tag/v0.1.0
