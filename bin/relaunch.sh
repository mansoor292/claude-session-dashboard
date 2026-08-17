#!/bin/bash
# Restore specific Claude sessions after a reboot. Reads ~/relaunch_sessions.tsv
# (rows: name<TAB>forked_session_id<TAB>cwd) and resumes each EXISTING session id
# via `claude --resume <id> --remote-control '<name>'` WITHOUT --fork-session, so the
# same online (claude.ai) session reconnects instead of minting a duplicate.
LOG="$HOME/relaunch.log"
echo "=== relaunch $(date -u +%FT%TZ) ===" >> "$LOG"
answer_prompts() {
  local name="$1"
  for i in 1 2 3 4 5 6; do
    sleep 3
    local pane; pane=$(tmux capture-pane -p -t "$name" -S -12 2>/dev/null)
    echo "$pane" | grep -q 'remote-control is active' && return 0
    if echo "$pane" | grep -q 'trust this folder'; then tmux send-keys -t "$name" '1' Enter; continue; fi
    if echo "$pane" | grep -qE 'Resume full session|Enter to confirm'; then tmux send-keys -t "$name" Enter; continue; fi
  done
}
while IFS=$'\t' read -r name sid cwd; do
  [ -z "$name" ] && continue
  if tmux has-session -t "$name" 2>/dev/null; then
    cmd=$(tmux display-message -p -t "$name" '#{pane_current_command}' 2>/dev/null)
    case "$cmd" in claude|node|2.1.*) echo "skip running: $name" >>"$LOG"; continue;;
      *) tmux kill-session -t "$name" 2>/dev/null; echo "cleared stale $cmd: $name" >>"$LOG";; esac
  fi
  proj="$(echo "$cwd" | sed 's#/#-#g')"
  [ -f "$HOME/.claude/projects/${proj}/${sid}.jsonl" ] || { echo "MISSING transcript: $name" >>"$LOG"; continue; }
  tmux new-session -d -s "$name" -c "$cwd" \
    "$HOME/.local/bin/claude --resume $sid --remote-control '$name' --dangerously-skip-permissions"
  answer_prompts "$name"
  echo "restored: $name" >>"$LOG"
done < "$HOME/relaunch_sessions.tsv"
