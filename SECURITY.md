# Security Policy

## Threat model

Jelly Local Sync is a **local-only** tool. It binds an HTTP server on your
machine (default `0.0.0.0:7777`) so phones on the same LAN, or tunnelling over
`adb reverse`, can post QA annotations to it. Nothing is sent to any remote
service.

Access control is **capability-based**: the server holds one current 64-bit
random session token, served on every `GET /` (so a browser refresh re-joins the
same room and the feed survives). Every API path is namespaced under
`/r/<token>/...`. A new token is minted only deliberately — via the **New
session** button (`POST /session/new`) or a process restart. Anyone who can reach
the port *and* knows the token has full read/write access to that room. A few
control routes (`/session/new`, `/clickup/*`, `/ping`) are token-agnostic and
reachable by anything that can reach the host:port. This is intentional and
appropriate for a local QA tool, it is **not** an internet-facing service and
should not be exposed to untrusted networks.

To limit exposure, bind to localhost only:

```bash
HOST=127.0.0.1 node server.mjs
```

## Supported versions

Only the latest published version on npm is supported. There are no LTS branches.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository (Security → Report a vulnerability), or
- Email **rajan.reachme@gmail.com** with details and reproduction steps.

You'll get an acknowledgement within a few days. Since this is a single-file
local tool with no runtime dependencies, the attack surface is small, but
reports are still welcome.
