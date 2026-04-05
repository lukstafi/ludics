#!/bin/bash
# ludics Stop Hook
# Installed by: ludics init --hooks
#
# This hook fires when Claude Code or Codex finishes a turn.
# It handles two distinct paths:
#   1. Orchestration agents: writes a stop-hook record to .peer-sync for the runner
#   2. Mag sessions: pops the next queued request and outputs a JSON decision
#
# Peer-sync routing (priority order):
#   1. Env vars LUDICS_PEER_SYNC_DIR / LUDICS_AGENT_NAME — set at session
#      startup via a project-level SessionStart hook in .claude/settings.local.json
#      (written by orchestration setup).  This is the primary path.
#   2. Marker file .ludics-orchestration.json at the worktree root — fallback
#      for Codex sessions or environments without Claude Code hook support.
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

# Determine peer-sync directory and agent name.
# Priority: env var > marker file.
# NOTE: The TypeScript equivalent is resolvePeerSyncDir() in src/orchestration/peer-sync.ts
# which implements: CLI arg > env var > null.  The shell hook has additional fallbacks
# (marker file walk-up) because it runs before the TypeScript
# binary and must bootstrap without prior context.
peer_sync_dir=""

# 1. Env var set externally (e.g. by a wrapper or test harness).
if [[ -n "${LUDICS_PEER_SYNC_DIR:-}" && -f "${LUDICS_PEER_SYNC_DIR}/phase" ]]; then
  peer_sync_dir="$LUDICS_PEER_SYNC_DIR"
fi

# 2. Marker file written by orchestration setup at each worktree root.
#    Also exports LUDICS_PEER_SYNC_DIR and LUDICS_AGENT_NAME so the
#    ludics process invoked below receives them.
if [[ -z "$peer_sync_dir" ]]; then
  check_dir="$cwd"
  while [[ -n "$check_dir" && "$check_dir" != "/" ]]; do
    if [[ -f "$check_dir/.ludics-orchestration.json" ]]; then
      marker_peer_sync=$(jq -r '.peerSyncDir // ""' "$check_dir/.ludics-orchestration.json" 2>/dev/null)
      marker_agent_name=$(jq -r '.agentName // ""' "$check_dir/.ludics-orchestration.json" 2>/dev/null)
      if [[ -n "$marker_peer_sync" && -f "$marker_peer_sync/phase" ]]; then
        peer_sync_dir="$marker_peer_sync"
        export LUDICS_PEER_SYNC_DIR="$marker_peer_sync"
        if [[ -n "$marker_agent_name" ]]; then
          export LUDICS_AGENT_NAME="$marker_agent_name"
        fi
        break
      fi
    fi
    check_dir=$(dirname "$check_dir")
  done
fi

# Orchestration stop-hook routing.  Only exec into orch on-stop when the shell
# successfully resolved a peer-sync dir (via env var or marker file).
# If peer_sync_dir is empty, fall through to mag queue-pop — do NOT check the
# raw LUDICS_PEER_SYNC_DIR env var here, because it may be stale (no phase file),
# and exec-ing would prevent the Mag fallback from running.
if [[ -n "$peer_sync_dir" ]]; then
  exec "$ludics_bin" orch on-stop "$cwd" "$peer_sync_dir" "$hook_event_name"
fi

# Mag session — queue-pop behavior
exec "$ludics_bin" mag queue-pop "$cwd" "$hook_event_name"
