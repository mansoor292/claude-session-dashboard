# claude-dev-box

A self-hosted, always-on box that runs many [Claude Code](https://claude.com/claude-code)
sessions at once and serves them — plus VS Code and any dev app — to the open web
over a single wildcard domain.

You get:

- **A session dashboard** (`app/server.js`) — a live **grid or sortable list** of every
  session with its Claude-set title, last output, status, and **per-session CPU/RAM**.
  One click opens the session in a browser terminal or its live claude.ai view.
- **A + Session launcher** that spawns a **Claude**, plain **shell**, or **Teleport**
  (pull a running cloud session down to the box) session in any repo — optionally
  isolated in its own **git worktree + branch**, and under any of your Claude accounts.
- **Launch-and-open** — starting a Claude session drops you straight into its live
  `claude.ai/code` session once remote-control registers.
- **Multi-account** — run sessions under a second (or third) Claude plan on the same box
  via per-account `CLAUDE_CONFIG_DIR`; the dashboard tags each session with its account.
- **A CPU/RAM monitor** at `/monitor` (whole-box, task-manager style).
- **A web terminal** (ttyd) that attaches any named session by URL.
- **VS Code in the browser** (code-server).
- **Port publishing** — a local app on port `NNNN` is instantly live at
  `https://pNNNN.<your-domain>`.
- **Durability** — named sessions are restored on reboot from a manifest that a timer
  keeps in sync, and reconnect to the *same* online (claude.ai) session rather than
  minting duplicates.

Everything is fronted by [Caddy](https://caddyserver.com) with an automatic Let's
Encrypt **wildcard** cert (DNS-01), behind HTTP basic auth.

> Built and running on a single AWS EC2 instance (`t3.xlarge`, Ubuntu 24.04), but
> nothing here is AWS-specific except the example route53 DNS plugin — swap in any
> [caddy-dns](https://github.com/caddy-dns) provider.

---

## Architecture

```
                       Caddy  (:443, wildcard *.dev.example.com, basic auth)
                         │
   ┌─────────────────────┼─────────────────────┬───────────────────────┐
   │                     │                     │                       │
 sessions.*            term.*                code.*                 pNNNN.*
 :5000 dashboard       :7681 ttyd            :8080 code-server      :NNNN your app
   │                     │
   │                     └── tmux-web → `tmux attach -t <arg>`  (attach by name, never creates)
   │
   └── reads: tmux + ~/.claude*/sessions/*.json (all accounts) + transcript mtimes + /proc
       writes: spawn/kill tmux sessions, create/remove git worktrees

 Basecamp bridge (optional, see below)
   bc-hook.service     → receiver on :8977, one webhook per connected project
   bc-watch.timer      → `bc-threads watch` every 2m: pings, adoption, poll fallback
   bc-authcheck.timer  → warns before the Basecamp OAuth token expires
```

- **Sessions are tmux sessions.** The dashboard shells out to `tmux` to list, spawn,
  and kill them, and reads `~/.claude/sessions/*.json` to surface remote-control
  (claude.ai-synced) sessions too.
- **Claude's terminal title flows through.** Claude Code sets an OSC title when you
  name a session; tmux captures it as `#{pane_title}`, and the dashboard shows it as
  the card heading.
- **Worktrees** live under `$CODE_ROOT/.worktrees/<repo>__<name>` on a branch
  `wt/<name>`, so a second session can work the same repo without touching your main
  checkout's files or branch.

---

## Prerequisites

- A Linux host you control (an always-on VM/EC2 instance works well).
- A **domain** and access to its DNS provider (for the wildcard cert via DNS-01).
- Installed on the box:
  - [Claude Code](https://claude.com/claude-code) (`~/.local/bin/claude`), logged in.
  - `node` (v18+), `tmux`, `git`.
  - [`ttyd`](https://github.com/tsl0922/ttyd) — web terminal.
  - [`code-server`](https://github.com/coder/code-server) — VS Code in the browser.
  - [Caddy](https://caddyserver.com) built with your DNS provider's plugin, e.g.
    `caddy add-package github.com/caddy-dns/route53`.

---

## Setup

### 1. The dashboard app

The app has **no dependencies** — a single file using only Node built-ins. You can copy
it out, or **run it straight from a clone of this repo** (recommended — the repo then *is*
the deploy: edit `app/server.js`, restart the service, done):

```bash
git clone https://github.com/<you>/claude-session-dashboard ~/session-dashboard
# service runs: node app/server.js   (see systemd/session-dashboard.service)
```

Configure via environment (see `.env.example`) — at minimum set your domain, e.g. in the
systemd unit: `Environment=DEV_DOMAIN=dev.example.com`.

> **Hidden sessions:** any tmux session whose name starts with `_` is excluded from the
> dashboard grid and from boot-restore. Use this for a control/meta session (e.g. one that
> edits the dashboard itself), ideally on a separate tmux socket so it's fully out of view.

### 2. Helper scripts

```bash
sudo cp bin/claude-grid bin/claude-ls bin/claude-sessions-init bin/tmux-web /usr/local/bin/
sudo chmod +x /usr/local/bin/{claude-grid,claude-ls,claude-sessions-init,tmux-web}
cp bin/relaunch.sh bin/manifest-sync.py ~/
chmod +x ~/relaunch.sh ~/manifest-sync.py
```

### 3. systemd services

Edit the units in `systemd/` for your user/paths/domain, then:

```bash
sudo cp systemd/*.service systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now session-dashboard ttyd
sudo systemctl enable --now claude-restore.service       # boot-time session restore
sudo systemctl enable --now claude-manifest.timer        # keeps the restore manifest fresh
```

### 4. Caddy (wildcard TLS + reverse proxy)

```bash
cp caddy/Caddyfile.example /etc/caddy/Caddyfile
# then edit: email, domain, and the basic_auth hash:
caddy hash-password        # paste the bcrypt hash into the Caddyfile
```

Put your **DNS provider credentials** in Caddy's service environment — a scoped IAM
user for route53, or the equivalent — **never in the Caddyfile and never committed.**
For route53 on AWS, an override like `/etc/systemd/system/caddy.service.d/env.conf`
with `Environment=AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...` works.

Add the wildcard DNS record (`*.dev.example.com` → your box's public IP), then:

```bash
sudo systemctl reload caddy
```

Visit `https://sessions.dev.example.com`.

---

## Using it

- **Spawn a session** — click **+ Session**, choose the **Type** (Claude / Shell /
  Teleport), pick a repo, optionally tick **worktree**, name it, Launch.
  - *Claude* opens a live `claude.ai/code` tab once remote-control registers.
  - *Shell* is a plain `bash` session (no Claude).
  - *Teleport* pulls a running cloud session onto the box — paste its session id or
    `claude.ai/code` URL; teleport self-selects (and clones) the matching repo.
- **Grid ⇄ List** — toggle in the header. List is sortable by name, repo, launched,
  **last used**, **CPU**, and **Mem** (click a column header).
- **Open a session** — click a card/row; it opens in the web terminal (or claude.ai
  for a remote-controlled session).
- **Kill a session** — the ✕; a worktree-backed session offers to remove its worktree
  and branch too.
- **Serve a dev app** — run it on any port `NNNN`; it's live at `https://pNNNN.<domain>`.
- **Open a repo in VS Code** — the `‹/› VS Code` link on each card/row.

### How a few things work

- **Per-session CPU/RAM** — the dashboard sums the whole process tree under each
  session's tmux panes (RSS for memory; interval-sampled `/proc` ticks for CPU, shown
  top-style as % of one core). Shown in the **list** view only.
- **"Last used"** reflects *any* access path (terminal, remote-control, claude.ai,
  mobile) — it's the max of tmux `session_activity` and the conversation transcript's
  mtime, so a session you only drive from the web still updates.
- **Launch-and-open / teleport** use Claude Code's remote-control: a local session runs
  in tmux and is surfaced at `claude.ai/code/<bridge>`. Teleport is a one-way handoff —
  after it, the local copy is independent of the original cloud session.

### Serving a localhost app from a session through Caddy

Anything a session listens on is instantly reachable on the web — no config change, no
restart. Caddy matches the host `pNNNN.<domain>` and reverse-proxies it to
`127.0.0.1:NNNN`, so the subdomain is just `p` + the port number.

From inside any session (a Claude session's Bash, or a plain shell):

```bash
npm run dev -- --port 3000        # Vite/Next/etc.
# or: python3 -m http.server 8000
# or: any server bound to a local port
```

Then open it over TLS at:

```
https://p3000.<your-domain>       # p8000.<your-domain>, etc.
```

How it's wired (`caddy/Caddyfile.example`):

```caddyfile
@portproxy header_regexp phost Host ^p([0-9]+)\.dev\.example\.com$
handle @portproxy {
    reverse_proxy 127.0.0.1:{re.phost.1}
}
```

Notes:

- **Bind to `127.0.0.1`** (or `0.0.0.0`) — Caddy proxies from localhost, so `127.0.0.1`
  is enough and keeps the app off the public interface except through Caddy.
- **Any port works**; the wildcard cert already covers `pNNNN.<domain>`, so it's HTTPS
  with no per-app setup.
- **These `pNNNN` hosts are NOT behind basic auth** in the template (unlike `sessions.`
  and `term.`). Treat whatever you serve as public — add auth in your app, or a
  `basic_auth` block on the `@portproxy` handler, if it's sensitive.

---

## Basecamp bridge (optional)

Sessions post to Basecamp; humans reply on the thread; the reply comes back to the session
that owns it. Needs the [Basecamp CLI](https://github.com/basecamp/claude-plugins) on PATH
and authenticated (`basecamp auth login`).

```bash
sudo cp bin/bc-threads bin/bc-hook /usr/local/bin/
sudo cp systemd/bc-hook.service systemd/bc-watch.{service,timer} systemd/bc-authcheck.{service,timer} /etc/systemd/system/
echo dev.example.com > ~/.claude/bc-hook-domain     # your wildcard domain
sudo systemctl enable --now bc-hook.service bc-watch.timer bc-authcheck.timer
```

From a session:

```bash
bc-threads post <project> "Subject" "body"   # post, register the thread, connect the project
bc-threads reply <recording> "text"          # answer on a thread
bc-threads list                              # threads → sessions, with claude.ai links
bc-threads projects                          # which projects this box is connected to
```

**How replies get home.** `~/.claude/bc-threads.json` maps a Basecamp recording to the tmux
session that owns it. A comment arrives by webhook (seconds); the receiver never trusts the
payload, it only triggers a re-fetch through the API, so a forged POST buys an extra poll and
nothing else. The 2-minute timer is the fallback for a missed hook, and the only route for
**pings** — direct messages have no webhook event type in Basecamp, so they are discovered
through notifications and read from the Circle chat lines API.

**Webhooks belong to the box↔project pair**, not to any thread or session: threads come and
go, sessions get unlinked, the connection outlives both. `bc-threads projects --connect/
--disconnect` manages it, and the dashboard's `/basecamp` page shows connections, thread↔
session links, and message history, with buttons to unlink a thread or disconnect a project.

**Delivery is gated on the session being idle** — messages are typed into the pane, so
delivering mid-turn would drop keystrokes into a running tool call. A busy session holds its
watermark and takes the batch on the next sweep. Nothing is dropped, and nothing is
truncated silently: an over-long comment is cut with a marker naming both lengths and
linking the original.

Config lives in `~/.claude/bc-threads.json`, never in this repo:

| key | meaning |
|---|---|
| `ping_from` | sender names whose pings get acted on (absent = everyone) |
| `ping_repo_filter` | substring picking which checkouts to offer for an unlinked ping |
| `account` | Basecamp account id, discovered on first use |
| `self` | the person id the CLI posts as, so our own comments never loop back |

**Sessions clarify before they build.** Append `docs/CLAUDE.md.basecamp.md` to
`~/.claude/CLAUDE.md` and a session receiving an underspecified request asks the person
back on the thread — numbered questions, all in one reply — rather than guessing, and does
the work once the answers land.

## Multiple Claude accounts (spillover to a second plan)

Claude's login is scoped to one account per config dir (`~/.claude`). To run sessions
under a **second** account on the same box — e.g. to keep going when the first hits its
usage limit — give that account its own config dir:

```bash
# on the box, log the second account in once (interactive OAuth):
CLAUDE_CONFIG_DIR=~/.claude-max2 claude      # then run /login as the 2nd account
```

The dashboard **auto-discovers** any `~/.claude-<name>` dir that has credentials (the
`<name>` becomes the account's label). Once a second account exists:

- the **+ Session** modal gains an **Account** picker (hidden while there's only one),
- each session shows a small **account badge**, and
- spawning under an account injects `CLAUDE_CONFIG_DIR` into that session so it runs on —
  and is billed to — that plan, and appears in that account's claude.ai.

Sessions from all accounts show together in one dashboard. Note this is one OS user, so
the accounts share the filesystem — fine for your own plans, not hard isolation between
different people.

---

## Security notes

- **This repo is a template. It ships no secrets.** The live `Caddyfile`, your `.env`,
  DNS credentials, `*.pem` keys, and the session manifest are `.gitignore`d — keep them
  that way.
- Everything web-facing sits behind **basic auth + TLS**. The dashboard binds to
  `127.0.0.1` and is only reachable through Caddy. Treat the box as sensitive: anyone
  who gets past auth has terminal access to your sessions.
- `claude ... --dangerously-skip-permissions` is used for unattended spawn/restore.
  That is appropriate only on a host you fully control and trust.

---

## Repo layout

```
app/server.js                 the dashboard (single-file Node app, no deps)
bin/                          helper scripts installed to /usr/local/bin and ~
bin/bc-threads, bin/bc-hook   Basecamp bridge: thread↔session routing, webhook receiver
docs/CLAUDE.md.basecamp.md    guidance to append to ~/.claude/CLAUDE.md
systemd/                      unit + timer files
caddy/Caddyfile.example       reverse proxy + wildcard TLS template
.env.example                  configurable environment variables
```

## License

MIT — see [LICENSE](LICENSE).
