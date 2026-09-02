#!/usr/bin/env python3
"""Regenerate ~/relaunch_sessions.tsv from the live Claude session registry.

Run periodically (see systemd/claude-manifest.timer) so newly spawned sessions are
captured for boot restore. Only tmux-bound, currently-alive sessions are written;
the rc-host env and dead pids are skipped. Atomic write + non-empty guard so a
transient empty read never wipes the manifest.

Every Claude account is scanned, not just the primary: an extra account lives in
~/.claude-<name> with its own sessions/ registry and its own transcripts, so a
session launched under one was previously invisible here and never restored.
Each row carries the owning config dir, which relaunch.sh passes back as
CLAUDE_CONFIG_DIR.
"""
import json, glob, os, re, sys, time
HOME = os.path.expanduser("~")

# A restore run rebuilds sessions one at a time and takes minutes. Syncing while one is in
# flight captures only the sessions restored SO FAR and silently drops the rest from the
# manifest, so the NEXT restore has no row for them at all — that is how tax-api,
# plan-engine, test and vto-builder were lost on 2026-09-02. Back off while relaunch.sh
# holds the lock; the staleness cap keeps a crashed run from freezing the manifest forever.
LOCK = os.path.join(HOME, ".relaunch-in-progress")
try:
    if time.time() - os.path.getmtime(LOCK) < 20 * 60:
        print("restore in progress — manifest left untouched")
        sys.exit(0)
except OSError:
    pass

def account_dirs():
    """~/.claude plus every logged-in ~/.claude-<name> (mirrors accounts() in app/server.js)."""
    dirs = [HOME + "/.claude"]
    try:
        for name in sorted(os.listdir(HOME)):
            path = os.path.join(HOME, name)
            if re.fullmatch(r"\.claude-[A-Za-z0-9_-]+", name) and os.path.isdir(path) \
               and os.path.exists(os.path.join(path, ".credentials.json")):
                dirs.append(path)
    except OSError:
        pass
    return dirs

rows = {}
for cfg in account_dirs():
    for f in glob.glob(os.path.join(cfg, "sessions", "*.json")):
        try: d = json.load(open(f))
        except Exception: continue
        name = (d.get("tmux","") or "").split(":")[0]
        if name.startswith("_"): continue             # hidden/internal session (e.g. dashboard control session)
        sid, cwd, pid = d.get("sessionId"), d.get("cwd"), d.get("pid")
        if not (name and sid and cwd): continue      # tmux-bound only (skips rc-hosted cloud sessions)
        if name == "rc-host": continue                # skip the claude rc env host itself
        if pid and not os.path.exists("/proc/%d" % pid): continue   # alive only
        rows[name] = (sid, cwd, cfg)
if rows:                                           # guard: never overwrite with an empty set
    p = os.path.join(HOME, "relaunch_sessions.tsv")
    with open(p + ".tmp", "w") as w:
        for name,(sid,cwd,cfg) in sorted(rows.items()):
            w.write("\t".join([name, sid, cwd, cfg]) + "\n")
    os.replace(p + ".tmp", p)                       # atomic
    print("synced", len(rows), "sessions")
else:
    print("no live sessions — manifest left untouched")
