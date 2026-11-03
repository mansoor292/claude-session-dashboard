#!/bin/bash
# Restore specific Claude sessions after a reboot. Reads ~/relaunch_sessions.tsv
# (rows: name<TAB>session_id<TAB>cwd<TAB>config_dir) and resumes each EXISTING session id
# via `claude --resume <id> --remote-control '<name>'` WITHOUT --fork-session, so the
# same online (claude.ai) session reconnects instead of minting a duplicate.
# Shared API keys ride into every session as process environment (same source the
# dashboard uses when it spawns or wakes a session). Without this a boot-restored session
# came up keyless until someone re-woke it (2026-11-03).
if [ -f "$HOME/.claude/secrets/.env" ]; then set -a; . "$HOME/.claude/secrets/.env"; set +a; fi
LOG="$HOME/relaunch.log"
MANIFEST="$HOME/relaunch_sessions.tsv"
LOCK="$HOME/.relaunch-in-progress"
echo "=== relaunch $(date -u +%FT%TZ) ===" >> "$LOG"
# Hold a lock for the whole run. manifest-sync rebuilds the manifest from LIVE sessions,
# so a sync landing mid-restore sees only the sessions restored SO FAR and drops the rest.
# On 2026-09-02 the timer fired 90s into a 22-session restore and pruned the last four
# (tax-api, plan-engine, test, vto-builder); the next restore had no rows for them and
# they stayed dead. manifest-sync now backs off while this file is fresh.
: > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
# manifest-sync rebuilds the manifest from LIVE sessions every few minutes, so any row that
# fails to restore here is pruned from it within minutes and cannot be retried after that.
# Keep the boot-time copy so a failed restore is still recoverable by hand.
cp -f "$MANIFEST" "$MANIFEST.lastboot" 2>/dev/null
answer_prompts() {
  local name="$1"
  for i in 1 2 3 4 5 6; do
    sleep 3
    local pane; pane=$(tmux capture-pane -p -t "$name" -S -12 2>/dev/null)
    echo "$pane" | grep -q 'remote-control is active' && return 0
    # New trust dialog: arrow list, "No, exit" preselected — Down+Enter picks Yes. Old: "1".
    if echo "$pane" | grep -q 'trust this folder'; then
      if echo "$pane" | grep -q 'No, exit'; then tmux send-keys -t "$name" Down; sleep 0.3; tmux send-keys -t "$name" Enter; else tmux send-keys -t "$name" '1' Enter; fi; continue; fi
    if echo "$pane" | grep -qE 'Resume full session|Enter to confirm'; then tmux send-keys -t "$name" Enter; continue; fi
  done
}
while IFS=$'\t' read -r name sid cwd cfg; do
  [ -z "$name" ] && continue
  cfg="${cfg:-$HOME/.claude}"                   # pre-4-column manifests are all primary
  if tmux has-session -t "$name" 2>/dev/null; then
    cmd=$(tmux display-message -p -t "$name" '#{pane_current_command}' 2>/dev/null)
    case "$cmd" in claude|node|2.1.*) echo "skip running: $name" >>"$LOG"; continue;;
      *) tmux kill-session -t "$name" 2>/dev/null; echo "cleared stale $cmd: $name" >>"$LOG";; esac
  fi
  # Claude mangles every '/', '.' AND '_' of the cwd into '-' for its transcript dir, so a
  # worktree at ~/Code/.worktrees/repo__wt lives in projects/-home-ubuntu-Code--worktrees-repo--wt.
  # Substituting only '/' silently missed every worktree session (see app/server.js projDir).
  proj="$(echo "$cwd" | sed 's#[/._]#-#g')"
  tx="$cfg/projects/${proj}/${sid}.jsonl"
  [ -f "$tx" ] || { echo "MISSING transcript: $name ($tx)" >>"$LOG"; continue; }
  # Non-primary accounts keep their transcripts and credentials in their own config dir.
  env_args=(); [ "$cfg" = "$HOME/.claude" ] || env_args=(-e "CLAUDE_CONFIG_DIR=$cfg")
  tmux new-session -d -s "$name" -c "$cwd" "${env_args[@]}" \
    "$HOME/.local/bin/claude --resume $sid --remote-control '$name' --dangerously-skip-permissions"
  answer_prompts "$name"
  echo "restored: $name" >>"$LOG"
done < "$MANIFEST"
