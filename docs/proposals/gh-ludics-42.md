# Proposal: Replace legacy session discovery with t3code thread discovery

**Task:** gh-ludics-42
**Effort:** medium
**Files changed:** 8 (1 new, 7 modified)

## Problem

Session discovery uses four independent scanners (claude JSONL, codex JSONL, tmux, ttyd) that don't know about t3code threads. The authoritative source of session data is now the t3code server snapshot.

## New: `src/sessions/discover-t3code.ts`

Queries the t3code server snapshot via `serverStatus()`, maps `T3Thread` records to `DiscoveredSession` with rich metadata: threadId, model, sessionStatus, turnState, branch, worktreePath, title, providerName.

## Modified files

1. **`src/types.ts`** — Added `"t3code"` to `AgentType` union
2. **`src/sessions/index.ts`** — `discoverAll()` uses t3code as primary source, falls back to legacy codex/claude scanners only when t3code returns nothing
3. **`src/sessions/enrich.ts`** — Reads orchestration from t3code slot state files first, `.peer-sync/` as fallback for non-t3code sessions
4. **`src/sessions/dedup.ts`** — t3code gets priority 3 (above codex/claude at 2)
5. **`src/sessions/report.ts`** — Markdown and JSON output include t3code fields (threadId, model, sessionStatus, turnState, branch)
6. **`src/sessions/sweep-state.ts`** — `"t3code"` added to `SweepMode`, cleanup uses `ludics t3code stop-thread <threadId>`
7. **`src/sessions/sweep.ts`** — `collectAttachedKeys()` reads t3code slot state, `knownSessionStillPresent()` checks snapshot, `runSessionSweep()` now async

## Remaining work

- Legacy scanners kept as fallback (not deleted yet)
- tmux/ttyd discovery not yet filtered to Mag-only
- No new tests for t3code discovery
- `t3code stop-thread` CLI subcommand not yet implemented
- `classify.ts` works as-is (no changes needed)

## Status

All 100 existing tests pass, TypeScript type-checks cleanly, build succeeds.
