# Proposal: Resume — reset shell state before re-booting agent CLI

**Task:** gh-ludics-146
**Date:** 2026-04-03

## Goal

When `slot resume` finds an existing tmux session, reset the shell state and verify the agent CLI is alive before proceeding. Currently the resume loop assumes a healthy agent CLI whenever the tmux session exists, which fails when the shell is stuck (e.g. `bquote>` mode) or the CLI process has died.

## Acceptance Criteria

1. When a tmux session exists during resume, the shell receives `C-c C-c Enter` to clear any stuck state before checking agent health.
2. After the reset sequence, `isAgentAlive()` is called; if the agent CLI is not running, it is re-booted using the same env+command sequence as the `!sessionExists` path.
3. Sending the reset sequence to a clean shell prompt or a healthy running agent CLI does not break anything (graceful no-op).
4. A brief delay (200ms) separates the reset sequence from the liveness check, giving the shell time to process signals.

## Context

- **Resume loop**: `src/slots/index.ts:910-930` — branches on `sessionExists` at line 912; the `else` (session exists) case is missing.
- **`tmuxSendKeys`**: `src/adapters/tmux.ts:55-61` — sends raw tmux keys; already supports `C-c`.
- **`isAgentAlive`**: `src/adapters/tmux-adapter.ts:299-310` — checks for agent CLI child processes via `pgrep`.
- **`agentCliCommand`**: `src/adapters/tmux-adapter.ts:326-329` — returns the CLI launch command.
- **`tmuxSendCommand`**: `src/adapters/tmux.ts:64-67` — sends literal text + Enter.

## Approach

In `src/slots/index.ts`, in the resume loop's `for` block over `orchState.agents`:

1. **Add `tmuxSendKeys` to the tmux import** (line 880) and **add `isAgentAlive` to the tmux-adapter import** (line 881).

2. **Add an `else` branch** after the `if (!sessionExists)` block (after line 930):

```typescript
} else {
  // Reset shell state: interrupt any stuck process / bquote mode
  tmuxSendKeys(sessionName, "C-c");
  tmuxSendKeys(sessionName, "C-c");
  tmuxSendKeys(sessionName, "Enter");
  await Bun.sleep(200);

  // Re-boot agent CLI if it died while the tmux session persisted
  if (!isAgentAlive(slotNum, agent.name, taskId)) {
    const envCmd = [
      `export LUDICS_SLOT=${slotNum}`,
      `LUDICS_AGENT=${agent.name}`,
      `LUDICS_PEER_SYNC_DIR="${orchState.peerSyncDir}"`,
    ].join(" ");
    tmuxSendCommand(sessionName, envCmd);
    tmuxSendCommand(sessionName, agentCliCommand(agent.provider));
    console.error(`ludics: re-booted ${agent.provider} CLI in existing session '${sessionName}'`);
  }
}
```

This reuses the same env-var and boot sequence as the `!sessionExists` path, keeping the logic consistent. No new functions need to be exported.
