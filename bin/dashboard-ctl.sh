#!/bin/bash
# Ensure the hidden dashboard control session exists on the `admin` tmux socket.
# It runs Claude in the dashboard repo with remote-control (reachable at claude.ai),
# kept OFF the default tmux socket so the dashboard never sees or restores it.
# The `_` name prefix also hides it from the dashboard grid + restore manifest.
#
# Because it is hidden it gets NO restore-manifest row, so relaunch.sh cannot bring it
# back — this script is the only thing that ever starts it, and until 2026-09-03 it always
# started it COLD. Every restart of the unit therefore minted a fresh session id and a
# fresh claude.ai bridge, abandoning the previous transcript on disk. That is how the
# 06:33 needrestart cycle silently replaced a two-day conversation with an empty one.
# STATE remembers the session id so a restart resumes the same conversation instead.
SOCK=admin
NAME=_dashboard
DIR=/home/ubuntu/session-dashboard
CLAUDE="$HOME/.local/bin/claude"
# Shared API keys ride into every session as process environment (same source the
# dashboard uses when it spawns or wakes a session). Without this a boot-restored session
# came up keyless until someone re-woke it (2026-11-03).
if [ -f "$HOME/.claude/secrets/.env" ]; then set -a; . "$HOME/.claude/secrets/.env"; set +a; fi
STATE="$HOME/.dashboard-session"
PROJ="$HOME/.claude/projects/$(echo "$DIR" | sed 's#[/._]#-#g')"

tmux -L "$SOCK" has-session -t "$NAME" 2>/dev/null && exit 0   # already up

# Resume the recorded conversation when its transcript is still on disk. The pointer is
# only ever advanced for a session started cold (below), never for one we resumed — so a
# burst of restarts cannot walk it forward onto the 7-second stubs each restart leaves
# behind, which is exactly what would have destroyed the history on 2026-09-03.
sid=""; [ -f "$STATE" ] && sid="$(tr -d '[:space:]' < "$STATE")"
if [ -n "$sid" ] && [ -f "$PROJ/$sid.jsonl" ]; then
  resumed=1
  tmux -L "$SOCK" new-session -d -s "$NAME" -c "$DIR" \
    "$CLAUDE --resume $sid --remote-control '$NAME' --dangerously-skip-permissions"
else
  resumed=0
  tmux -L "$SOCK" new-session -d -s "$NAME" -c "$DIR" \
    "$CLAUDE --remote-control '$NAME' --dangerously-skip-permissions"
fi

# auto-answer the first-run trust / bypass / resume prompts, then stop once RC registers
up=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  p=$(tmux -L "$SOCK" capture-pane -p -t "$NAME" 2>/dev/null)
  echo "$p" | grep -q 'remote-control is active' && { up=1; break; }
  echo "$p" | grep -q 'trust this folder' && tmux -L "$SOCK" send-keys -t "$NAME" 1 Enter
  echo "$p" | grep -qE 'Resume full session|Enter to confirm' && tmux -L "$SOCK" send-keys -t "$NAME" Enter
  echo "$p" | grep -qE 'Bypass Permissions mode' && echo "$p" | grep -q 'Yes, I accept' && tmux -L "$SOCK" send-keys -t "$NAME" 2 Enter
done

# A cold start just minted a session id; record it so the next restart resumes it. Its
# transcript is the newest in the project dir at this instant — we only just wrote the
# SessionStart lines into it. Guarded on `up` so a start that never came up cannot
# overwrite a good pointer with a dead one.
if [ "$resumed" = 0 ] && [ "$up" = 1 ]; then
  new="$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)"
  [ -n "$new" ] && basename "$new" .jsonl > "$STATE"
fi
