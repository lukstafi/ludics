# Proposal: Peer-sync state reliability — validation, status reset, PR file hardening

**Task:** gh-ludics-242
**Date:** 2026-04-13

## Goal

Make `.peer-sync/` state transitions more reliable by: (1) resetting agent status files on phase entry so stale statuses cannot be misread, (2) adding post-transition validation that logs missing artifacts, and (3) hardening `.pr` file writing so `validateAndFixPrFile` fires earlier and more reliably.

## Acceptance Criteria

1. On every phase transition, each participating agent's `.status` file is overwritten with a known initial value (e.g., `{phase}-pending|{epoch}|awaiting`) before dispatch. The fingerprint baseline is captured after this reset.
2. After `writePeerSync()` in `enterPhase()`, a validation step checks that expected artifacts from the *previous* phase exist (e.g., review files after `review`, plan files after `plan`). Missing artifacts are logged as warnings in the orchestration log — not blocking.
3. `validateAgentPrFiles()` runs as soon as the agent's turn settles in `pr-create` phase (current behavior), but additionally: if the `.pr` file exists but fails `isPrUrl()`, it is repaired immediately without waiting for a second poll cycle.
4. All existing tests pass; `bun run build` succeeds.

## Context

### Gap 1: Stale status files across phase transitions

`writePeerSync()` (peer-sync.ts:120-135) updates orchestrator-level files (phase, round, state.json) but does NOT reset per-agent `.status` files. After a phase transition, each agent's `.status` still contains the previous phase's done status (e.g., `plan-done|...|completed`). The `isStatusFresh()` fingerprint gate (phases.ts:214-234) prevents this from being misread — but only if `dispatchStatusFingerprint` was captured correctly. Edge cases (crash between `touchStatusFile` and fingerprint capture, or agent writing status between touch and capture) can cause stale status to appear fresh.

The fix: in `enterPhase()` (runner.ts:495), after `writePeerSync()` and `markActiveAgents()`, explicitly write each participating agent's `.status` file to a reset value. Then capture `dispatchStatusFingerprint` from the reset file. This makes the fingerprint mechanism a safety net rather than the primary correctness mechanism.

### Gap 2: Inter-round context

Per user guidance: reviewer feedback (`PEER_REVIEW` template variable) is sufficient inter-round context. Recovered agents reconnect to the same session thread via `claude -c`, preserving conversation context. No changes needed here.

### Gap 3: `.pr` file fragility

The `pr-create` template uses `gh pr create ... | tee "{{PR_FILE}}"` which can capture extra output. `validateAndFixPrFile()` (github.ts:103-131) repairs this reactively but only after the turn settles. The repair should be more aggressive: on each poll cycle during `pr-create`, if the `.pr` file exists but isn't a valid URL, attempt repair immediately rather than waiting for settled state.

## Approach

### 1. Status file reset in `enterPhase()` (runner.ts)

After `markActiveAgents(state)` (line 512) and before the per-agent dispatch loop:

```typescript
// Reset status files to known initial state before dispatch
for (const agent of participatingAgents) {
  const statusPath = path.join(peerSyncDir, `${agent.name}.status`);
  const resetStatus = `${state.phase}-pending|${Date.now()}|awaiting`;
  fs.writeFileSync(statusPath, resetStatus, "utf-8");
}
```

Then `touchStatusFile()` (line 586) can be kept as-is or removed — the reset write already establishes the baseline. Capture fingerprint after reset.

### 2. Post-transition artifact validation in `enterPhase()` (runner.ts)

After `writePeerSync()`, before dispatch, add a validation call:

```typescript
validatePreviousPhaseArtifacts(state, peerSyncDir);
```

New function in runner.ts (or peer-sync.ts):

```typescript
function validatePreviousPhaseArtifacts(state: OrchestrationState, peerSyncDir: string): void {
  const prevPhase = state.previousPhase; // needs to be captured before overwrite
  if (!prevPhase) return;
  
  for (const agent of state.agents) {
    const artifactPath = requiredArtifactPath(prevPhase, state, agent, peerSyncDir);
    if (artifactPath && !fs.existsSync(artifactPath)) {
      orchLog(state, `warn`, `Missing artifact from ${prevPhase}: ${path.basename(artifactPath)} (${agent.name})`);
    }
  }
}
```

This is diagnostic only — it logs warnings but does not block the transition.

### 3. Eager `.pr` file repair in poll loop (runner.ts)

In `pollUntilDone()`, the `pr-create` check at line ~901 currently gates on turn settled state. Add an earlier check: on each poll cycle, if `.pr` file exists and `!isPrUrl(content)`, call `validateAndFixPrFile()` immediately. This catches the case where the agent wrote a bad `.pr` file but hasn't reported done yet.

### Files to modify

- `src/orchestration/runner.ts` — `enterPhase()` (status reset + validation), `pollUntilDone()` (eager PR repair)
- `src/orchestration/peer-sync.ts` — optional: add `resetAgentStatuses()` helper if cleaner than inline

### Files NOT modified

- Skill templates — no prompt changes per user guidance
- `skills.ts` / `buildSkillContext()` — inter-round context is sufficient as-is
- `phases.ts` — existing `isStatusFresh()` and `hasRequiredArtifact()` remain as safety nets
