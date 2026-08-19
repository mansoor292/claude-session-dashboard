#!/bin/bash
# Ensure the hidden dashboard control session exists on the `admin` tmux socket.
# It runs Claude in the dashboard repo with remote-control (reachable at claude.ai),
# kept OFF the default tmux socket so the dashboard never sees or restores it.
# The `_` name prefix also hides it from the dashboard grid + restore manifest.
SOCK=admin
NAME=_dashboard
DIR=/home/ubuntu/session-dashboard
CLAUDE="$HOME/.local/bin/claude"

tmux -L "$SOCK" has-session -t "$NAME" 2>/dev/null && exit 0   # already up

tmux -L "$SOCK" new-session -d -s "$NAME" -c "$DIR" \
  "$CLAUDE --remote-control '$NAME' --dangerously-skip-permissions"

# auto-answer the first-run trust / bypass prompts, then stop once RC registers
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  p=$(tmux -L "$SOCK" capture-pane -p -t "$NAME" 2>/dev/null)
  echo "$p" | grep -q 'remote-control is active' && break
  echo "$p" | grep -q 'trust this folder' && tmux -L "$SOCK" send-keys -t "$NAME" 1 Enter
  echo "$p" | grep -qE 'Bypass Permissions mode' && echo "$p" | grep -q 'Yes, I accept' && tmux -L "$SOCK" send-keys -t "$NAME" 2 Enter
done
