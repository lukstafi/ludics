# Proposal: Capture tmux pane output at round end for retrospective

**Task**: task-1ebbc1c3
**Project**: ludics

## Goal

Fill the retrospective gap for tmux-mode sessions. Currently, when `backend === "tmux"`, `state.threadIds` is empty so `collectAndWriteRetrospective()` produces 0 turns and 0 threads — all diagnostic value is lost. After this change, tmux-mode retrospectives will contain structured, per-round captures of each agent's visible terminal output.

## Acceptance Criteria

1. When orchestration completes with `backend === "tmux"`, the retrospective JSON contains non-empty `turns` and `threads` arrays reflecting captured agent output.
2. Captures happen after each `pollUntilDone` call in the main loop (not just at task completion), preserving multi-round history.
3. Only agents that participate in the current phase (per `agentParticipatesInPhase`) are captured.
4. Captured output uses structured bullet-point extraction (reusing the pattern from `publishTerminalState` in `mag.ts`) rather than raw line dumps.
5. If a tmux session is gone at capture time (`tmuxCapture` returns null), capture is silently skipped.
6. Captures are deduped: if the content hash matches the previous capture for the same agent, no new entry is stored.
7. The t3code path is unchanged — capture logic only runs when `state.backend === "tmux"`.
8. Captures survive crash recovery (persisted before the next poll iteration).

## Context

- **The 0-turns problem**: In `retrospective.ts`, `collectAndWriteRetrospective()` iterates `state.threadIds` (line 523). In tmux mode this map is empty (`{}` — set at adapter init, line 482 of `tmux-adapter.ts`), so the loop body never executes.
- **Existing capture utilities**: `tmuxCapture(session, lines)` in `src/adapters/tmux.ts` wraps `tmux capture-pane -p -S -<lines>`. `tmuxSessionName(slot, agentName, taskId)` in `src/adapters/tmux-adapter.ts` generates the correct session target. `tmuxPaneOutputHash` already captures and hashes pane content for stall detection.
- **publishTerminalState pattern** (`src/mag.ts` line 544): Captures 50 lines, finds the last `⏺` marker (Claude Code output start), trims to the last `❯` prompt, strips separator lines, deduplicates via MD5 hash. This structured extraction produces clean, readable output rather than raw terminal dumps.
- **User decisions**: No preference between in-state storage and on-disk storage — let implementers choose. Must reuse the `publishTerminalState` bullet-point extraction pattern.

## Approach

Implementation details (storage format, exact line counts) are left to the implementer. The key architectural constraints are:

1. **Capture point**: After each `pollUntilDone` return in `runOrchestration()` (around line 1078 of `runner.ts`), before the phase transition logic. Guard with `if (state.backend === "tmux")`.

2. **Structured extraction**: Reuse the `publishTerminalState` extraction logic from `mag.ts` — find the last agent output marker, trim prompts and separators, produce clean text. Generalize the marker detection to handle both Claude Code (`⏺`) and Codex output patterns. Extract this into a shared utility (e.g., `extractCleanPaneOutput(raw: string, provider: string): string | null`).

3. **Agent iteration**: Only capture for agents where `agentParticipatesInPhase(state, agent)` returns true. Use `tmuxSessionName(state.slot, agent.name, state.taskId)` to get the capture target.

4. **Deduplication**: Hash each cleaned capture (MD5, same as `tmuxPaneOutputHash`) and skip if identical to the previous capture for the same agent.

5. **Storage**: Either accumulate in `OrchestrationState` (new array field) or write to `peerSyncDir/captures/` files — implementer's choice. Either way, must persist before the next `pollUntilDone` so crash recovery preserves captures.

6. **Retrospective integration**: In `collectAndWriteRetrospective()`, when `state.backend === "tmux"`, read accumulated captures and convert them to `RetrospectiveTurn` entries:
   - `threadId`: `"tmux-capture"` (synthetic)
   - `agentName`: from agent config
   - `turnIndex`: sequential per agent
   - `turnId`: null
   - `phase`: phase at capture time
   - `timestamp`: capture ISO timestamp
   - `message`: cleaned captured text

   Also create synthetic `RetrospectiveThread` entries so the summary line reflects tmux data.

7. **Capture size**: 200 lines per agent per round is a reasonable middle ground (more than the 50 used for stall detection, less than the 5000 max buffer).
