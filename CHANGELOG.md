# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-06-05

Initial public release.

### Added
- Zero-dependency local server (`server.mjs`) implementing a subset of the Jelly
  MCP-style `/sessions` HTTP contract, so the Android / iOS / web SDKs sync
  unmodified.
- Single-page dashboard (`public/index.html`) — left rail with a live Devices
  list, QR-first "Scan to connect" hero, and a live annotation feed over SSE.
- `npx jelly-local-sync` one-liner: starts the server and auto-opens the
  dashboard in the default browser. Opt out with `--no-open` / `NO_OPEN=1`;
  auto-skipped when stdout is not a TTY.
- Local-only contract extensions: `POST /hello` (device identity + heartbeat),
  `POST /annotations/:id/image` (binary screenshot upload), `DELETE /annotations`
  (browser-side bulk clear).
- Per-device attribution by client IP, multi-device support over one URL.
- Request body caps (256 KB JSON, 25 MB image) returning `413` on overflow.

[Unreleased]: https://github.com/rajanndube/jelly-local-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rajanndube/jelly-local-sync/releases/tag/v0.1.0
