# Resume: reset shell state before re-booting agent CLI in existing tmux session

## Goal

When `slot resume` encounters an existing tmux session, it currently assumes the agent CLI inside is healthy. In practice the shell may be stuck (e.g. `bquote>` mode from triple-backtick output) or the agent CLI process may have exited while the tmux session persists. This leaves the slot in a broken state that requires manual intervention.

Fix the resume path so that existing tmux sessions are reset and, if the agent CLI is not running, re-booted automatically.

Ref: https://github.com/lukstafi/ludics/issues/146

## Acceptance Criteria

1. When `slot resume` finds an existing tmux session for an agent, it sends interrupt signals (`C-c`) to clear any stuck shell state before proceeding.
2. After resetting, if the agent CLI process is not alive (per `isAgentAlive`), the CLI is re-booted with the correct environment variables — same as the session-missing path.
3. If the agent CLI is already alive and healthy, resume does not disrupt it beyond the harmless `C-c` signals.
4. A brief delay is inserted between the reset signals and the alive check so the shell has time to process the interrupts.

## Context

### Current resume flow (`src/slots/index.ts`, lines ~900-945)

The tmux resume block iterates over `orchState.agents`. For each agent it calls `tmuxHasSession(sessionName)`:

- **Session missing** (line 912-930): Creates a new tmux session, sets env vars via `tmuxSendCommand`, boots the agent CLI via `agentCliCommand`.
- **Session exists**: Falls through with no action — this is the gap.

After the per-agent loop, ttyd is re-created if its port is free (lines 932-944).

### Key utilities

| Function | Location | Purpose |
|---|---|---|
| `tmuxSendKeys` | `src/adapters/tmux.ts:55-61` | Send raw tmux key sequences (e.g. `C-c`). Not literal by default. |
| `tmuxSendCommand` | `src/adapters/tmux.ts:64-67` | Send literal text + Enter. |
| `isAgentAlive` | `src/adapters/tmux-adapter.ts:299-310` | Uses `pgrep` to check if agent CLI (claude/codex) is a child of the pane shell. Already exported. |
| `agentCliCommand` | `src/adapters/tmux-adapter.ts:326-329` | Returns the CLI launch command string for a provider. |
| `bootAgentCli` | `src/adapters/tmux-adapter.ts:273-293` | Private function that sets env vars and launches CLI. The resume code in `index.ts` already inlines this logic for the session-missing path. |

### Import gap

The resume code (line 880) imports `tmuxSendCommand` but not `tmuxSendKeys`. It imports `agentCliCommand` but not `isAgentAlive` (line 881). Both need to be added to the respective dynamic imports.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Add an `else` branch at line 930 (when `sessionExists` is true):

1. Import `tmuxSendKeys` from `../adapters/tmux.ts` and `isAgentAlive` from `../adapters/tmux-adapter.ts` in the existing dynamic import lines.
2. Send `C-c` twice via `tmuxSendKeys(sessionName, "C-c")` to interrupt any stuck process or clear partial input.
3. Wait ~200ms (`await Bun.sleep(200)`) for the shell to process.
4. Call `isAgentAlive(slotNum, agent.name, taskId)`.
5. If not alive, re-send the env-var export and `agentCliCommand` — identical to lines 922-929.
6. Log the action via `console.error`.

## Scope

**In scope:**
- The `else` branch for existing tmux sessions in the resume function
- Adding the two missing imports (`tmuxSendKeys`, `isAgentAlive`)

**Out of scope:**
- Changes to `bootAgentCli` (it remains private; the inline pattern is already established)
- Changes to agent health-check logic or `isAgentAlive` implementation
- Handling non-tmux adapters (t3code resume is a separate code path)
