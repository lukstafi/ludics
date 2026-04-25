# Proposal: Convert deferred atomic-write sites + transactional slot-assign

**Task:** task-29bea074
**Date:** 2026-04-25

## Goal

Convert the remaining non-atomic `writeFileSync` sites that gh-ludics-303 explicitly deferred — across `mag.ts`, `cluster.ts`, `orchestration/runner.ts`, and `slots/index.ts` — to the established `atomicWriteFileSync` / `writeJsonFile{,Compact}` / `writeStatusFile` helpers. While in `slots/index.ts`, also batch the three-write `taskUpdateForSlotAssign` sequence (slot, adapter, started) into a single read → mutate-in-memory → atomic-write cycle so the slot-assign step itself becomes crash-safe rather than just per-field atomic.

## Acceptance Criteria

1. `src/mag.ts:473` (`saveStartupAlertState`) uses `writeJsonFile(path, state)` (byte-exact: pretty + trailing `\n`).
2. `src/mag.ts:674` (`markFeedbackDigestQueued`) uses `writeJsonFileCompact(path, state)` (accepted 1-byte format drift: gains a trailing `\n`, per Q1 resolution).
3. `src/cluster.ts:158` (`publishHeartbeat` local file branch) uses `writeJsonFileCompact(path, heartbeatData)` (byte-exact match), with import of `writeJsonFileCompact` from `./json.ts`.
4. `src/orchestration/runner.ts:784` (pr-comments-done reset) uses `writeStatusFile(statusPath, "pr-comments-done", "awaiting-comments")` — gains trailing `\n`, aligning with PR #369 (per Q2 resolution).
5. `src/orchestration/runner.ts:846` (phase-entry reset) uses `writeStatusFile(statusPath, `${state.phase}-pending`, "awaiting")` — gains trailing `\n` (per Q2 resolution).
6. `src/orchestration/runner.ts:1006` (`.merged` marker) uses `atomicWriteFileSync(markerFile, "merged\n")` (byte-exact).
7. `src/orchestration/runner.ts:1571` (stub merged plan markdown) uses `atomicWriteFileSync(mergedPath, [...].join("\n"))` (byte-exact).
8. `src/orchestration/runner.ts:1727` (`triggerCoderBailOut` consolidated bail-out helper) uses `writeStatusFile(path, "bail-out", runtime.statusMessage)` — current trailing `\n` already matches helper output (per Q2 resolution).
9. `src/slots/index.ts:212` (`taskUpdateFrontmatter`) uses `atomicWriteFileSync(file, output.join("\n"))` (byte-exact).
10. `taskUpdateForSlotAssign` is refactored so its three field updates (slot, adapter, started) read the task file once, mutate the parsed frontmatter object in memory for all three fields, then perform a single `atomicWriteFileSync`. A crash mid-sequence is no longer possible.
11. `taskUpdateForSlotClear` continues to work unchanged (it reuses `taskUpdateFrontmatter` for one-field updates).
12. New imports added where needed: `writeJsonFileCompact` in `cluster.ts`; `atomicWriteFileSync` in `slots/index.ts`; `atomicWriteFileSync` and `writeStatusFile` in `orchestration/runner.ts`; `writeJsonFile` and `writeJsonFileCompact` in `mag.ts`.
13. `bun test`, `bun run typecheck`, and `bun run build` all green.
14. No unrelated `writeFileSync` sites are touched (dashboard writes and ephemeral/sentinel files remain as-is per gh-ludics-303 plan).
15. Format drifts beyond byte-exact preservation are limited to those documented above (Q1: mag.ts:674 gains `\n`; Q2: runner.ts:784 and :846 gain `\n`).

## Context

gh-ludics-303 (PR #369) standardised most state-file writes to atomic helpers but explicitly deferred 8 sites listed in the coder's `suggestRefactorSummary` and `workflowFeedback`. Those sites continued to use raw `writeFileSync`. The follow-up task this proposal addresses sweeps them in one pass.

Since elaboration on 2026-04-24:
- task-1e6b2aad consolidated runner.ts:1476 + 1563 into a single helper `triggerCoderBailOut` (now line 1727), so the count is **8 call sites in 4 files** rather than 9.
- PR #357 did **not** eliminate any of the deferred sites — re-grep on 2026-04-25 confirms each one is still raw `writeFileSync`.
- Helpers required all exist: `atomicWriteFileSync`, `writeJsonFile`, `writeJsonFileCompact` (`src/json.ts`); `writeStatusFile` (`src/adapters/base.ts`).

The user resolved the three elaboration questions on 2026-04-25:

- **Q1 (mag.ts trailing-newline drift):** Use `writeJsonFileCompact` for consistency with cluster.ts:158 (also compact JSON), accepting the 1-byte format drift.
- **Q2 (runner.ts pipe-delimited status writes):** Semantic convergence — replace all three with `writeStatusFile`. Adds `\n` to the two sites that currently lack it; aligns with PR #369's standardisation.
- **Q3 (multi-step slot-assign atomicity):** **Expand scope** — wrap `taskUpdateForSlotAssign`'s three sequential writes into a single read → mutate-in-memory → atomic-write. No follow-up task; the fix lands here.

## Approach

### Per-site migration (8 sites in 4 files)

| File | Line | Symbol | New call |
|------|------|--------|----------|
| `src/mag.ts` | 473 | `saveStartupAlertState` | `writeJsonFile(startupAlertStateFile(), state)` |
| `src/mag.ts` | 674 | `markFeedbackDigestQueued` | `writeJsonFileCompact(feedbackDigestStateFile(), state)` |
| `src/cluster.ts` | 158 | `publishHeartbeat` (local file branch) | `writeJsonFileCompact(join(dir, `${nodeName}.json`), heartbeatData)` |
| `src/orchestration/runner.ts` | 784 | pr-comments-done reset | `writeStatusFile(statusPath, "pr-comments-done", "awaiting-comments")` |
| `src/orchestration/runner.ts` | 846 | phase-entry reset | `writeStatusFile(statusPath, `${state.phase}-pending`, "awaiting")` |
| `src/orchestration/runner.ts` | 1006 | `.merged` marker | `atomicWriteFileSync(markerFile, "merged\n")` |
| `src/orchestration/runner.ts` | 1571 | stub merged plan markdown | `atomicWriteFileSync(mergedPath, [...].join("\n"))` |
| `src/orchestration/runner.ts` | 1727 | `triggerCoderBailOut` (consolidated) | `writeStatusFile(join(state.peerSyncDir, `${coder.name}.status`), "bail-out", runtime.statusMessage)` |
| `src/slots/index.ts` | 212 | `taskUpdateFrontmatter` | `atomicWriteFileSync(file, output.join("\n"))` |

### Imports to add

- `src/mag.ts`: add `writeJsonFile, writeJsonFileCompact` to existing `./json.ts` import.
- `src/cluster.ts`: add `import { writeJsonFileCompact } from "./json.ts";`.
- `src/orchestration/runner.ts`: add `import { atomicWriteFileSync } from "../json.ts";` and `import { writeStatusFile } from "../adapters/base.ts";`.
- `src/slots/index.ts`: add `import { atomicWriteFileSync } from "../json.ts";`.

### Transactional `taskUpdateForSlotAssign` (Q3)

Current shape (`src/slots/index.ts:215-230`):

```typescript
function taskUpdateForSlotAssign(taskId: string, slot: number, adapter: string, started: string): void {
  // ... existsSync + transitionStatus checks ...
  taskUpdateFrontmatter(taskId, "slot", String(slot));
  taskUpdateFrontmatter(taskId, "adapter", adapter);
  taskUpdateFrontmatter(taskId, "started", started);
}
```

Three sequential read-modify-writes — a crash between any two leaves the task with partial assignment (e.g. `slot: 5` but no `adapter`/`started`).

Refactor: introduce a small helper that takes a map of `field → value` and performs one read, one in-memory mutation pass over all fields, and one atomic write. Reuse the same line-walking logic that `taskUpdateFrontmatter` uses today (preserves output format byte-for-byte for unchanged lines) but apply all updates in a single pass:

```typescript
function taskUpdateFrontmatterFields(taskId: string, updates: Record<string, string>): void {
  const file = taskFilePath(taskId);
  if (!existsSync(file)) return;
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  let inFrontmatter = false;
  const remaining = new Set(Object.keys(updates));
  const output: string[] = [];
  for (const line of lines) {
    if (line === "---" && !inFrontmatter) { inFrontmatter = true; output.push(line); continue; }
    if (line === "---" && inFrontmatter) { inFrontmatter = false; output.push(line); continue; }
    if (inFrontmatter) {
      let matched = false;
      for (const field of remaining) {
        if (line.startsWith(`${field}:`)) {
          output.push(`${field}: ${updates[field]}`);
          remaining.delete(field);
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    output.push(line);
  }
  atomicWriteFileSync(file, output.join("\n"));
}

function taskUpdateForSlotAssign(taskId: string, slot: number, adapter: string, started: string): void {
  // ... existsSync + transitionStatus checks unchanged ...
  taskUpdateFrontmatterFields(taskId, {
    slot: String(slot),
    adapter,
    started,
  });
}
```

Then `taskUpdateFrontmatter(taskId, field, value)` is rewritten as a thin wrapper that delegates to `taskUpdateFrontmatterFields(taskId, { [field]: value })`, so `taskUpdateForSlotClear` and any other single-field callers keep working unchanged. The single-field call still benefits from atomic write (criterion 9).

### Behavioural notes

- `transitionStatus` (called twice in `taskUpdateForSlotAssign` before the field updates) already does its own atomic-write of the `status` field. That's a separate read-modify-write upstream of the three field updates — leaving it as-is is fine; this proposal scopes "transactional slot-assign" to the three-field write itself, matching the Q3 wording.
- `writeStatusFile` (used at runner.ts:784, 846, 1727) derives its own epoch from `Date.now()`, replacing the caller's `nowEpoch()` allocation. The runtime `statusEpoch` field tracked separately in `runtime.statusEpoch` continues to be set explicitly by callers — only the on-disk status file's epoch shifts to the helper's internal value (sub-millisecond drift from the caller-side `nowEpoch()`, cosmetic).
- The redundant `mkdirSync(magStateDir(), { recursive: true })` lines at `mag.ts:472` and `mag.ts:673` are no-op duplicates (the helpers also `mkdirSync` the parent), but leaving them in place keeps the diff minimal — removing them is a separate cleanup at the implementer's discretion.

### Verification

- `bun test` (full suite — none of these sites have crash-injection coverage; we rely on existing functional tests around slot assignment, heartbeat publishing, status-file fingerprinting, and bail-out flow).
- `bun run typecheck`.
- `bun run build`.
- Visual diff a captured `.status` file before/after on lines 784/846 to confirm the only delta is the trailing `\n`.
- Confirm slot-assign still produces a frontmatter with all three fields after `ludics slot assign` against a test task.
