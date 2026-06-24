#!/bin/bash
# ludics Stop Hook
# Installed by: ludics init --hooks
#
# This hook fires when Claude Code or Codex finishes a turn.
# It handles two distinct paths:
#   1. Orchestration agents: writes a stop-hook record to .peer-sync for the runner
#   2. Mag sessions: pops the next queued request and outputs a JSON decision
#
# Invocation modes:
#   - Claude Code: called as Stop hook with JSON on stdin ({hook_event_name, cwd, ...})
#   - Codex: called as notify command with $1 = "codex" (no stdin; uses $PWD for cwd)
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

# Ensure Bash 4+ and tools like jq/yq are available (macOS system bash is v3).
# $HOME/.local/bin is added additively (gh-ludics-590): on Linux workers jq often
# lives there, and the macOS Homebrew prepend stays so Mac workers/leader are unaffected.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# Resolve jq to an absolute path (gh-ludics-590), mirroring the ludics_bin fallback
# below. The orchestration on-stop hook hard-depends on jq to parse the Stop-hook JSON
# (cwd / hook_event_name) and the marker-file walk-up reads; a bare `jq` on a
# macOS-centric PATH silently exits 127 → empty cwd → lost phase signals. Resolve it
# once here, before the mode branch, so BOTH the Claude-stdin and Codex notify paths
# (the marker-file reads) use the resolved binary.
jq_bin="$(command -v jq 2>/dev/null || true)"
if [[ -z "$jq_bin" ]]; then
  for bin in "$HOME/.local/bin/jq" "$HOME/.local/ludics/bin/jq"; do
    if [[ -x "$bin" ]]; then
      jq_bin="$bin"
      break
    fi
  done
fi
if [[ -z "$jq_bin" ]]; then
  # Fail loud naming jq — do NOT hand an empty/defaulted cwd to `ludics orch on-stop`,
  # which surfaces only as a confusing downstream `usage:` error (gh-ludics-590).
  echo "ludics-on-stop: jq not found (need jq on PATH or in \$HOME/.local/bin) — cannot parse Stop-hook JSON; orchestration phase signals would be lost. Install jq (macOS: brew install jq / Linux: apt install jq)." >&2
  exit 1
fi

# Detect invocation mode: Codex passes "codex" as $1; Claude Code provides JSON on stdin.
invocation_mode="${1:-claude}"

if [[ "$invocation_mode" == "codex" ]]; then
  # Codex notify hook: no stdin JSON, use PWD for cwd.
  cwd="$PWD"
  hook_event_name="Stop"
else
  # Claude Code Stop hook: read JSON from stdin.
  input=$(cat)

  # Ignore subagent stops; only handle top-level Stop events.
  hook_event_name=$(echo "$input" | "$jq_bin" -r '.hook_event_name // ""' 2>/dev/null)
  if [[ "$hook_event_name" == "SubagentStop" ]]; then
    exit 0
  fi

  # Extract cwd from the stop event
  cwd=$(echo "$input" | "$jq_bin" -r '.cwd // ""' 2>/dev/null)
fi

# gh-ludics-597: the invoking provider, passed to `orch on-stop` as a 4th arg so
# it can disambiguate stop-hook attribution in pair mode (shared worktree). The
# value must match the `<agent>-agent` provider files: "codex" / "claude-code".
if [[ "$invocation_mode" == "codex" ]]; then
  provider="codex"
else
  provider="claude-code"
fi

# gh-ludics-589: never exec `ludics orch on-stop` (or `mag on-stop`) with a blank
# first positional — that shifts the positional args and produced a `usage: ludics
# orch on-stop <cwd> ...` error that blocked phase advancement. A blank cwd can
# arise from ANY cause (e.g. jq missing → empty `.cwd`, owned by gh-ludics-590);
# default it to $PWD so the exec always receives a real directory.
if [[ -z "$cwd" ]]; then
  cwd="$PWD"
fi

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
      marker_peer_sync=$("$jq_bin" -r '.peerSyncDir // ""' "$check_dir/.ludics-orchestration.json" 2>/dev/null)
      marker_agent_name=$("$jq_bin" -r '.agentName // ""' "$check_dir/.ludics-orchestration.json" 2>/dev/null)
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
# If peer_sync_dir is empty, fall through to mag on-stop — do NOT check the
# raw LUDICS_PEER_SYNC_DIR env var here, because it may be stale (no phase file),
# and exec-ing would prevent the Mag fallback from running.
if [[ -n "$peer_sync_dir" ]]; then
  exec "$ludics_bin" orch on-stop "$cwd" "$peer_sync_dir" "$hook_event_name" "$provider"
fi

# Codex only needs orchestration routing — no Mag settled signal.
if [[ "$invocation_mode" == "codex" ]]; then
  exit 0
fi

# Mag session — mark settled (Claude Code only)
exec "$ludics_bin" mag on-stop "$cwd" "$hook_event_name"
