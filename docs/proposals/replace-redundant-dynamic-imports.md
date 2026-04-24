# Replace redundant dynamic imports with top-level static imports in tmux-adapter/runner/slots paths

## Goal

Eliminate four production sites where `await import(...)` destructures names that are *also* (or *should also be*) imported statically at the top of the same file. These are redundant rebindings — not lazy-loading for circular-dep reasons — and they shadow the existing static imports, which makes the code harder to read and trips static-analysis tooling looking for "import shadowed by local declaration" smells.

This task was repurposed from the original "Rename shadowed imports: harnessDir in cluster.ts and init.ts" scope. Those original `harnessDir` shadows were already resolved under gh-ludics-376 (commits `7497285` and `7d901b9` dropped the imports). A broader audit of `src/` then surfaced the dynamic-import variant of the same smell at the four sites addressed here. Related: gh-ludics-376.

## Acceptance Criteria

- The four production dynamic-import shadow sites listed under **Context** below are converted to use top-level static imports. Each `await import(...)` line is removed; every name it bound is reachable via the file's top-level static import list.
- No new symbols are introduced; the existing static imports are extended with the names previously destructured dynamically.
- `bun run typecheck && bun run lint && bun run build && bun test` all pass.
- Test files (`src/**/*.test.ts`) are out of scope and remain untouched, even where they contain similar dynamic-import patterns.
- No behavior changes: the four call sites continue to do the same thing; only the import shape changes.

## Context

Audit of `src/` (excluding `*.test.ts`) found exactly four production sites where a dynamic `await import(...)` destructures names that the file already imports — or trivially could import — statically. In all four cases, the target module does not import back from the calling module, so there is no circular-dependency reason for the lazy load.

### Site 1 — `src/adapters/tmux-adapter.ts`, paste-buffer submission path

Inside the helper that performs `safeSyncOutput(["tmux", "load-buffer", promptFile])` and `safeSyncOutput(["tmux", "paste-buffer", ...])` (the `[Pasted Content`-style submission path):

```ts
const { writeFileSync, unlinkSync } = await import("fs");
```

The file already has `import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";` at the top, so `unlinkSync` is shadowed and `writeFileSync` just needs to be added to that list.

### Site 2 — `src/orchestration/runner.ts`, `ensureTtydAlive`

```ts
const { readTmuxSlotState, writeTmuxSlotState, startTtyd, agentPortRole } =
  await import("../adapters/tmux-adapter.ts");
```

The file already has `import { readTmuxSlotState } from "../adapters/tmux-adapter.ts";` at the top, so `readTmuxSlotState` is shadowed and the other three names should be promoted to the same static import.

### Site 3 — `src/slots/index.ts`, tmux resume path

In the branch guarded by `if (ctx.mode === "tmux")` near the comment `// --- tmux-specific: verify/recreate tmux session, windows, ttyd, agent CLIs ---`:

```ts
const { tmuxHasSession, tmuxNewSession, tmuxSendCommand, tmuxSendKeys } = await import("../adapters/tmux.ts");
const { readTmuxSlotState, writeTmuxSlotState, tmuxSessionName, ttydPort, agentCliCommand, isAgentAlive, startTtyd } = await import("../adapters/tmux-adapter.ts");
```

The file already has `import { readTmuxSlotState } from "../adapters/tmux-adapter.ts";` at the top — `readTmuxSlotState` is shadowed. Both dynamic imports should be promoted to top-level static imports (one consolidated import line per source module).

### Site 4 — `src/slots/index.ts`, orchestration-pid recovery branch

Lower in the same file, in the `} else if (ctx.mode === "tmux") {` branch that writes `{ ...tmuxState, orchestration: { ...tmuxState.orchestration!, pid: newPid } }`:

```ts
const { readTmuxSlotState, writeTmuxSlotState } = await import("../adapters/tmux-adapter.ts");
```

Same pattern. After Site 3 is fixed, both names will already be in the top-level static import for this file, so this line is just deleted.

### Why this is safe

`tmux-adapter.ts` does not import from `runner.ts` or `slots/index.ts`, and `tmux.ts` does not import from `slots/index.ts`. Promoting these to top-level static imports cannot introduce a cycle. The dynamic-import form here was defensive, not load-bearing.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. `src/adapters/tmux-adapter.ts`: add `writeFileSync` to the existing top-level `from "fs"` import; delete the `const { writeFileSync, unlinkSync } = await import("fs");` line.
2. `src/orchestration/runner.ts`: extend the existing top-level `from "../adapters/tmux-adapter.ts"` import to include `writeTmuxSlotState`, `startTtyd`, `agentPortRole`; delete the `await import(...)` destructure inside `ensureTtydAlive`.
3. `src/slots/index.ts`:
   - Add a new top-level `import { tmuxHasSession, tmuxNewSession, tmuxSendCommand, tmuxSendKeys } from "../adapters/tmux.ts";` (or extend if one already exists).
   - Extend the existing top-level `from "../adapters/tmux-adapter.ts"` import to also include `writeTmuxSlotState, tmuxSessionName, ttydPort, agentCliCommand, isAgentAlive, startTtyd`.
   - Delete both `await import(...)` destructure lines (the resume-path one and the orchestration-pid recovery one).
4. Run the gate: `bun run typecheck && bun run lint && bun run build && bun test`. All four must pass before commit.

The title rename from "Rename shadowed imports: harnessDir in cluster.ts and init.ts (audit for similar shadowings)" to "Replace redundant dynamic imports with top-level static imports in tmux-adapter/runner/slots paths" reflects the repurposed scope; the worker proposes updating the task title as part of the proposal phase.

## Scope

**In scope:**
- The four production sites enumerated above, in `src/adapters/tmux-adapter.ts`, `src/orchestration/runner.ts`, and `src/slots/index.ts`.

**Out of scope:**
- Test files. The ~25 similar dynamic-import sites in `src/skills.test.ts`, `src/adapters/tmux-adapter.test.ts`, etc. remain as-is per the user's resolution.
- Other dynamic imports in the same files that are *not* shadowed by an existing static import (e.g., `await import("../cluster-http.ts")`, `await import("./tmux-capture.ts")`, `await import("bun:sqlite")`, etc.). These are genuine lazy-loads or one-off uses and stay as-is.
- Any rename of `harnessDir` or restoration of dropped `harnessDir` imports in `cluster.ts`/`init.ts` — that ship has sailed (gh-ludics-376).

**Dependencies:** None. No interaction with any in-flight task.
