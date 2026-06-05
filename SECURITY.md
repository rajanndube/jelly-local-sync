# Security Policy

## Threat model

Jelly Local Sync is a **local-only** tool. It binds an HTTP server on your
machine (default `0.0.0.0:7777`) so phones on the same LAN, or tunnelling over
`adb reverse`, can post QA annotations to it. Nothing is sent to any remote
service.

Access control is **capability-based**: each `GET /` mints a fresh 64-bit random
token, and every API path is namespaced under `/r/<token>/...`. Anyone who can
reach the port *and* knows the token has full read/write access to that room.
This is intentional and appropriate for a local QA tool, it is **not** an
internet-facing service and should not be exposed to untrusted networks.

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
- Email **rajan@aspora.com** with details and reproduction steps.

You'll get an acknowledgement within a few days. Since this is a single-file
local tool with no runtime dependencies, the attack surface is small, but
reports are still welcome.
