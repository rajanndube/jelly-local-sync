# Contributing

Thanks for your interest in Jelly Local Sync. It's a deliberately tiny,
zero-dependency tool, the bar for new code is "does this stay simple and keep
the SDK wire contract intact?"

## Ground rules

- **No runtime dependencies.** The whole point is `npx` with nothing to install.
  Built-in Node modules only. PRs that add a `dependencies` entry will be
  declined unless there's no other way.
- **No build step.** `server.mjs` runs as-is; the page is plain
  `public/index.html` + `public/app.css` + `public/app.js` (hand-written, no
  bundler or transpiler). Keep it that way.
- **Don't break the wire contract.** The Android SDK decodes with strict
  `kotlinx.serialization`, a renamed or missing field breaks sync *silently*.
  Server changes must stay backward-compatible with the SDK schemas. When in
  doubt, `curl` the endpoint and confirm the response shape.
- **The vendored `public/qrcode.js` is off-limits** to hand-edits. If it needs
  updating, copy a fresh build from `node_modules/qrcode-generator/dist/`, do
  not hand-roll a QR encoder (we tried; it shipped subtly broken QRs).

## Development

```bash
git clone https://github.com/rajanndube/jelly-local-sync
cd jelly-local-sync
node server.mjs        # http://localhost:7777
npm test               # boots the server and smoke-tests the endpoints
```

There's no install step, `npm test` runs against the raw files.

## Licensing & sign-off (DCO)

This project is **source-available under the [PolyForm Shield 1.0.0](LICENSE.md)
licence** — free to use, modify, and distribute, but not to build a competing
product. By contributing, you agree your contribution is licensed under those
same terms.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) — a lightweight, sign-off-based alternative to a CLA. It's a statement
that you wrote the patch (or otherwise have the right to submit it). To sign off,
add a `Signed-off-by` trailer to each commit:

```bash
git commit -s -m "your message"
```

This appends `Signed-off-by: Your Name <you@example.com>` using your
`git config user.name` / `user.email`. PRs whose commits aren't signed off will
be asked to amend (`git rebase --signoff main` fixes a whole branch).

## Pull requests

1. Branch off `main`.
2. Keep the change focused; update `README.md` and `CHANGELOG.md` if behavior changes.
3. Make sure `npm test` passes locally (CI runs it on Node 18/20/22).
4. `main` is protected, changes land via PR, not direct push.
5. Sign off your commits (`git commit -s`, see above).
6. Commit with the email tied to your GitHub account (`git config user.email "you@…"`)
   so your work is attributed to you in the contributor graph. A machine-local
   default like `you@your-laptop.local` links to nobody and leaves you uncredited.

## Reporting issues

Use the issue templates. For anything security-sensitive, see [SECURITY.md](SECURITY.md).
