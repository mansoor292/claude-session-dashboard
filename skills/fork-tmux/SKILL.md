---
name: fork-tmux
description: Fork this session into a new tmux session on the box (same directory, full history, its own Remote Control link) — managed like every other session. Use when the user says /fork-tmux, "fork me in place", "fork this into tmux", or wants a copy of this conversation as a separate managed session. Not the desktop app's fork, which runs outside tmux.
user-invocable: true
---

# /fork-tmux [name]

Fork the current session into a new tmux session on this box. Run exactly this, with the
name the user gave (or none):

```bash
fork-tmux [name]
```

Then relay its output to the user verbatim: the new session's name, cwd and claude.ai link.
Do not do anything else in this turn — the fork carries everything up to the point the
command ran, and the user chooses which of the two sessions continues the work.

Notes
- Same working directory and git checkout as this session; nothing is copied or moved.
- The fork is a managed session: dashboard card, sleep/wake, boot restore, Basecamp bridge.
- It owns no Basecamp thread. `bc-threads track <thread> <name>` binds one.
- If the command fails with "not inside a tmux session", say so: only tmux-hosted sessions
  can be forked this way.
