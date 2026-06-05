# ClickUp integration — one-time setup

Push synced annotations straight into ClickUp as Tasks or Bugs, prefilled with
the comment, severity → priority, and the screenshot attached.

This is a **one-time, ~5-minute** setup. After it, anyone using this machine
clicks **Connect → ClickUp**, approves once (reusing their existing ClickUp
login — no token typing), and the **Create ticket** button on every annotation
card just works.

## Why an OAuth app (and not "just reuse my logged-in tab")

A page served from `localhost:7777` can't borrow your `app.clickup.com` session:
browser cookies are locked to ClickUp's origin, ClickUp's API rejects them
anyway, and `api.clickup.com` sends no CORS headers so the page can't call it
directly. OAuth is the only path that reuses "already logged in" without a
pasted personal token. The token is exchanged and stored **server-side**; it
never reaches the browser.

## Steps — all in the UI

### 1. Open the setup form

In the dashboard, click **Connect** (left-rail footer) → on the **ClickUp** row
click **Set up**. The form shows the exact **Redirect URL** to register (copy
button included) and fields for the keys.

### 2. Create a ClickUp OAuth app

1. ClickUp → your avatar (bottom-left) → **Settings**.
2. Sidebar → **ClickUp API** (under *Integrations*) → **Create an App**.
3. **App Name:** `Jelly Local Sync` (anything).
4. **Redirect URL:** paste the value the setup form shows — exactly. It's
   `http://localhost:<PORT>/clickup/callback`, port-matched to your server.
5. Save. ClickUp shows a **Client ID** and **Client Secret**.

### 3. Paste the keys → Connect

Back in the setup form, paste the **Client ID** and **Secret**, click
**Save & Connect**. A popup opens ClickUp's consent screen — because you're
already logged in, it's a one-click **Allow**, then it closes itself. The
button now reads **ClickUp · &lt;your workspace&gt;**.

> The keys are stored server-side in `~/.jelly-local-sync/oauth-app.json` — never
> in the browser and never in the repo. Power users / CI can instead set
> `CLICKUP_CLIENT_ID` + `CLICKUP_CLIENT_SECRET` env vars, or drop a gitignored
> `clickup-oauth.json` next to `server.mjs`; both are picked up automatically.

### 4. Use it

On any annotation card, click **Create ticket** → choose **Task** or **Bug**,
pick a **Space**, then a **List**, tweak the title, and **Create**. The task is
created with the annotation's markdown as the description, severity mapped to
ClickUp priority, and the screenshot attached. You get an **Open in ClickUp**
link.

## Notes

- **The token persists.** It's saved to `~/.jelly-local-sync/clickup.json`, so a
  server restart keeps you connected. **Disconnect** (in the Connect modal)
  clears it.
- **Bug vs Task.** If your workspace has a custom **Bug** task type, the Bug
  toggle creates a real ClickUp Bug. If not, it falls back to prefixing the
  title with 🐞 so creation never fails.
- **Multiple workspaces.** The first authorized workspace is used. (Multi-
  workspace selection is a future enhancement.)
- **Security.** The Client Secret and access token live server-side only. The
  browser never sees either.
