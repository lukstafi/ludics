# Pervasive Session Discovery: Implementation Handoff

*Design document, 2026-02-09. See also: [codex_app_ideas.md](codex_app_ideas.md)*

## Motivation

Today, ludics adapters are **launchers** — they create tmux sessions, manage state files,
track PIDs. This means ludics only sees sessions it started. Sessions started via VS Code
extensions, the Codex App GUI, bare CLI invocations, or other tools are invisible.

The goal: ludics should automatically discover and track **all** agentic sessions running
on the system, regardless of how they were started. The adapter becomes an **observer**.

## Key Insight: Shared Session Stores

Both major agent platforms maintain a single session store that all their clients share:

**Codex**: `~/.codex/sessions/*.jsonl` (or `$CODEX_HOME/sessions/`)
- CLI, App GUI, VS Code Extension, and app-server all read/write the same store
- Each session is a JSONL file with thread metadata (ID, cwd, model, timestamps)
- `~/.codex/archived_sessions/` holds completed threads
- The `thread/list` API (via app-server) has a `sourceKinds` filter: `cli`, `vscode`,
  `exec`, `appServer` — confirming all clients share one pool

**Claude Code**: `~/.claude/projects/` contains session data per project
- Terminal and VS Code Extension sessions land in the same place

**agent-duo/solo**: `.agent-sessions/*.session` symlinks + `.peer-sync/` state files
- These provide orchestration-level context (phase, round, agent coordination)
- Not discoverable from the agent session stores alone

## Design: Two-Layer Architecture

### Layer 1: Raw Session Discovery (new)

Scan the shared session stores to find all active sessions. This is the new capability.

Sources:
- `~/.codex/sessions/*.jsonl` — all Codex threads
- `~/.claude/projects/` — all Claude Code sessions
- `tmux ls` — active terminal sessions (existing behavior)
- ttyd PIDs / ports — web-accessible terminals (existing behavior)

For each discovered session, extract: agent type, working directory, last activity
timestamp, source (cli/app/vscode), thread/session ID.

### Layer 2: Enrichment (existing adapters, kept)

When a discovered session's `cwd` matches a known orchestration context, the structured
adapters (agent-duo.sh, agent-solo.sh) layer on richer information:

- `.peer-sync/` exists in cwd → add phase, round, agent coordination status
- `.agent-sessions/` exists in project root → group related sessions by feature

This enrichment is **additive** — it never prevents a session from being tracked. A Codex
thread in `~/myapp-auth-codex/` that has `.peer-sync/` gets the agent-duo view. A Codex
thread in `~/random-project/` with no `.peer-sync/` gets basic tracking.

### Deduplication

A single real-world session may appear in multiple sources (e.g., a tmux-based Codex CLI
session shows up in both `tmux ls` and `~/.codex/sessions/`). Correlate by `cwd` — if
the working directory matches, it's the same session. The richer source wins for display.

Similarly, an agent-duo orchestrated Codex session should not produce both an agent-duo
slot entry and a standalone codex slot entry. When a discovered session matches an
agent-duo session (same cwd), the agent-duo adapter claims it.

## Mag's Role: Auto-Categorization

When the session watcher detects a new session that doesn't match any existing slot or
orchestration context:

1. Mag is notified (queue message or direct)
2. Mag categorizes: project, likely task, appropriate slot
3. If a slot is available, Mag assigns the session
4. If not, Mag logs it for the briefing

This replaces the current model where slots must be manually assigned before work begins.
Sessions that are already part of an agent-duo/solo workflow get assigned to their
existing slot automatically.

## What This Replaces

The current codex.sh adapter's `adapter_codex_start()` creates tmux sessions, writes
`~/.config/ludics/codex/*.state` files, manages PIDs. Most of this becomes unnecessary:

- **State files** (`*.state`, `*.status`): replaced by reading `~/.codex/sessions/`
- **tmux session creation**: still available for dispatch, but not required for tracking
- **PID tracking for ttyd**: still needed for web terminal management
- **`adapter_codex_signal()`**: could be replaced by reading thread completion from
  the session store, but remains useful for agent-duo's explicit status protocol

The `start()` and `stop()` functions remain for Mag-dispatched work (via
`agent-duo start` etc.), but `read_state()` becomes the primary interface and draws
from the shared session stores.

## Task Dispatch: Stays Simple

ludics Mag dispatches tasks via shell commands:
- `agent-duo start <feature> --auto-run`
- `agent-solo start <feature> --auto-run`
- Or just `codex` / `claude` in a tmux session

No app-server protocol, no SDK integration. The dispatch tools (agent-duo, agent-solo)
handle all session setup. ludics's job is to **observe the results**, not to replicate
the setup logic.

## Cross-Machine Discovery (Future)

For Tailscale-connected machines in the federation:
- The state repo (already git-synced) carries slot assignments and task status
- Remote session stores could be polled via SSH or shared filesystem
- Remote tmux sessions are already accessible via ttyd + Tailscale

## Open Questions

1. **Session store format**: need to inspect actual `~/.codex/sessions/*.jsonl` files to
   understand the schema — what fields are available, how to detect "active" vs "done"
2. **Claude Code session format**: need to inspect `~/.claude/projects/` structure — is
   there a reliable way to detect active sessions vs historical data?
3. **Polling vs watching**: should `slots_refresh` poll the session stores on each call,
   or should a WatchPaths trigger detect new session files?
4. **Stale session cleanup**: how to detect that a session in `~/.codex/sessions/` is
   truly finished vs just idle? The thread store may not have explicit "active" flags.
5. **Performance**: scanning JSONL files on every refresh may be too slow if there are
   many historical sessions. May need to filter by modification time.
