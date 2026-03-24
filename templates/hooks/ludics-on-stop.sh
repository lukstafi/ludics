#!/bin/bash
# ludics Stop Hook
# Installed by: ludics init --hooks
#
# This hook fires when Claude Code or Codex finishes a turn.
# It handles two distinct paths:
#   1. Orchestration agents: writes a stop-hook record to .peer-sync for the runner
#   2. Mag sessions: pops the next queued request and outputs a JSON decision
#
# Loop prevention (Mag): when the queue is empty, mag_queue_pop outputs nothing
# (exit 0), so Claude stops naturally.

# Ensure Bash 4+ and tools like jq/yq are available (macOS system bash is v3)
export PATH="/opt/homebrew/bin:$PATH"

# Read Stop event input from stdin
input=$(cat)

# Ignore subagent stops; only handle top-level Stop events.
hook_event_name=$(echo "$input" | jq -r '.hook_event_name // ""' 2>/dev/null)
if [[ "$hook_event_name" == "SubagentStop" ]]; then
  exit 0
fi

# Extract cwd from the stop event
cwd=$(echo "$input" | jq -r '.cwd // ""' 2>/dev/null)

# Resolve ludics binary
ludics_bin=""
if command -v ludics >/dev/null 2>&1; then
  ludics_bin="ludics"
else
  for bin in "$HOME/.local/bin/ludics" "$HOME/.local/ludics/bin/ludics"; do
    if [[ -x "$bin" ]]; then
      ludics_bin="$bin"
      break
    fi
  done
fi

if [[ -z "$ludics_bin" ]]; then
  exit 0
fi

# Check if this cwd belongs to an orchestration worktree (has .peer-sync/phase).
# Walk up from cwd to find .peer-sync — agents may be in subdirectories.
check_dir="$cwd"
peer_sync_dir=""
while [[ -n "$check_dir" && "$check_dir" != "/" ]]; do
  if [[ -f "$check_dir/.peer-sync/phase" ]]; then
    peer_sync_dir="$check_dir/.peer-sync"
    break
  fi
  check_dir=$(dirname "$check_dir")
done

if [[ -n "$peer_sync_dir" ]]; then
  # Orchestration agent stop — notify the runner
  exec "$ludics_bin" orch on-stop "$cwd" "$peer_sync_dir" "$hook_event_name"
fi

# Mag session — queue-pop behavior
exec "$ludics_bin" mag queue-pop "$cwd" "$hook_event_name"
