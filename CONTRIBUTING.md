# Contributing

Thanks for your interest in Jelly Local Sync. It's a deliberately tiny,
zero-dependency tool — the bar for new code is "does this stay simple and keep
the SDK wire contract intact?"

## Ground rules

- **No runtime dependencies.** The whole point is `npx` with nothing to install.
  Built-in Node modules only. PRs that add a `dependencies` entry will be
  declined unless there's no other way.
- **No build step.** `server.mjs` runs as-is; `public/index.html` is hand-written
  HTML + CSS + inline JS. Keep it that way.
- **Don't break the wire contract.** The Android SDK decodes with strict
  `kotlinx.serialization` — a renamed or missing field breaks sync *silently*.
  Server changes must stay backward-compatible with the SDK schemas. When in
  doubt, `curl` the endpoint and confirm the response shape.
- **The vendored `public/qrcode.js` is off-limits** to hand-edits. If it needs
  updating, copy a fresh build from `node_modules/qrcode-generator/dist/` — do
  not hand-roll a QR encoder (we tried; it shipped subtly broken QRs).

## Development

```bash
git clone https://github.com/rajanndube/jelly-local-sync
cd jelly-local-sync
node server.mjs        # http://localhost:7777
npm test               # boots the server and smoke-tests the endpoints
```

There's no install step — `npm test` runs against the raw files.

## Pull requests

1. Branch off `main`.
2. Keep the change focused; update `README.md` and `CHANGELOG.md` if behavior changes.
3. Make sure `npm test` passes locally (CI runs it on Node 18/20/22).
4. `main` is protected — changes land via PR, not direct push.

## Reporting issues

Use the issue templates. For anything security-sensitive, see [SECURITY.md](SECURITY.md).
