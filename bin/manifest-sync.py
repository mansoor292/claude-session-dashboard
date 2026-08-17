#!/usr/bin/env python3
"""Regenerate ~/relaunch_sessions.tsv from the live Claude session registry.

Run periodically (see systemd/claude-manifest.timer) so newly spawned sessions are
captured for boot restore. Only tmux-bound, currently-alive sessions are written;
the rc-host env and dead pids are skipped. Atomic write + non-empty guard so a
transient empty read never wipes the manifest.
"""
import json, glob, os
rows = {}
for f in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
    try: d = json.load(open(f))
    except Exception: continue
    name = (d.get("tmux","") or "").split(":")[0]
    sid, cwd, pid = d.get("sessionId"), d.get("cwd"), d.get("pid")
    if not (name and sid and cwd): continue      # tmux-bound only (skips rc-hosted cloud sessions)
    if name == "rc-host": continue                # skip the claude rc env host itself
    if pid and not os.path.exists("/proc/%d" % pid): continue   # alive only
    rows[name] = (sid, cwd)
if rows:                                           # guard: never overwrite with an empty set
    p = os.path.expanduser("~/relaunch_sessions.tsv")
    with open(p + ".tmp", "w") as w:
        for name,(sid,cwd) in sorted(rows.items()):
            w.write(name+"\t"+sid+"\t"+cwd+"\n")
    os.replace(p + ".tmp", p)                       # atomic
    print("synced", len(rows), "sessions")
else:
    print("no live sessions — manifest left untouched")
