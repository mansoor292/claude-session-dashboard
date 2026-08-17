# claude-dev-box

A self-hosted, always-on box that runs many [Claude Code](https://claude.com/claude-code)
sessions at once and serves them — plus VS Code and any dev app — to the open web
over a single wildcard domain.

You get:

- **A session dashboard** (`app/server.js`) — a live grid of every session with its
  Claude-set title, last output, and status. One click opens the session in a browser
  terminal. A **+ Session** modal spawns a new **Claude** or plain **shell** session in
  any repo, optionally isolated in its own **git worktree + branch**. Killing a
  worktree-backed session offers to remove its worktree and branch.
- **A CPU/RAM monitor** at `/monitor` (task-manager style).
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
   │                     └── tmux-web → `tmux new-session -A -s <arg>`  (attach by name)
   │
   └── reads: `tmux list-sessions` + ~/.claude/sessions/*.json
       writes: spawn/kill tmux sessions, create/remove git worktrees
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

```bash
mkdir -p ~/session-dashboard
cp app/server.js ~/session-dashboard/server.js
```

Configure it via environment (see `.env.example`) — at minimum set your domain:

```bash
export DEV_DOMAIN=dev.example.com   # or set it in the systemd unit
```

The app has **no dependencies** — it's a single file using only Node built-ins.

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

- **Spawn a session** — click **+ Session**, choose Claude vs Shell, pick a repo,
  optionally tick **worktree**, name it, Launch.
- **Open a session** — click a card; it opens in the web terminal.
- **Serve a dev app** — run it on any port `NNNN`; it's live at `https://pNNNN.<domain>`.
- **Open a repo in VS Code** — the `‹/› VS Code` link on each card.

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
systemd/                      unit + timer files
caddy/Caddyfile.example       reverse proxy + wildcard TLS template
.env.example                  configurable environment variables
```

## License

MIT — see [LICENSE](LICENSE).
