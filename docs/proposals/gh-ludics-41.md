# Proposal: Remove legacy agent-duo integration code

**GitHub issue:** lukstafi/ludics#41
**Date:** 2026-03-13
**Status:** draft

## Summary

Remove all agent-duo, agent-pair-codex, and agent-pair-claude adapter code and references from ludics. These adapters depended on the external `agent-duo` CLI (lukstafi/agent-duo), which has been discontinued in favor of t3code. The removal spans adapter modules, the shared orchestrated-adapter framework, notification action buttons, slot assignment logic, session sweep/enrich code, Mag-side monitoring, config templates, and documentation references.

## Motivation

The agent-duo system (dual-agent orchestrator with peer-sync coordination) has been replaced by t3code (thread-based sessions via a shared server). The agent-duo CLI is no longer maintained, and the three orchestrated adapters in ludics (agent-duo, agent-pair-codex, agent-pair-claude) are dead code. Removing them:

- Eliminates ~750 lines of unused adapter/orchestration code
- Removes confusing notification action buttons for non-functional adapters
- Simplifies session sweep and Mag monitoring logic
- Reduces the adapter registry from 9 to 6 entries
- Cleans up config templates and documentation

## Coordination with gh-ludics-43

The gh-ludics-43 proposal already removes the three agent-duo/pair action buttons from `buildProposalNotificationActions()` in `src/notify.ts` (Change 2 in that proposal). This proposal covers the same button removal as part of a broader cleanup. Whichever lands first handles those three lines; the other proposal should adjust accordingly. All other changes in this proposal are independent of gh-ludics-43.

## Changes

### Change 1: Delete adapter files

**Delete these files entirely:**

| File | Content |
|------|---------|
| `src/adapters/agent-duo.ts` | 24 lines, agent-duo adapter (calls `createOrchestratedAdapter`) |
| `src/adapters/agent-pair-claude.ts` | 27 lines, agent-pair-claude adapter |
| `src/adapters/agent-pair-codex.ts` | 27 lines, agent-pair-codex adapter |
| `src/adapters/orchestrated-adapter.ts` | 741 lines, shared orchestrated-adapter framework |

The `orchestrated-adapter.ts` module is only imported by the three adapter files above. No other code depends on it. The `peer-sync.ts` module it imports is independently used by `notify.ts`, `sessions/sweep.ts`, `agent-session.ts`, and `t3code.ts` — it stays.

### Change 2: Remove from adapter registry

**File:** `src/adapters/index.ts`

Remove imports and registry entries for the three adapters:

```typescript
// DELETE these imports (lines 9-11):
import * as agentDuo from "./agent-duo.ts";
import * as agentPairCodex from "./agent-pair-codex.ts";
import * as agentPairClaude from "./agent-pair-claude.ts";

// DELETE these registry entries (lines 20-22):
  "agent-duo": agentDuo,
  "agent-pair-codex": agentPairCodex,
  "agent-pair-claude": agentPairClaude,
```

After: the registry contains 6 adapters: agent-claude, agent-codex, claude-ai, chatgpt-com, manual, t3code.

### Change 3: Remove agent-duo action buttons from notifications

**File:** `src/notify.ts`, function `buildProposalNotificationActions()` (lines 124-133)

Remove the three discontinued adapter buttons:

```typescript
// DELETE (lines 125-127):
    action("agent-duo", `Launch agent-duo for ${taskId} in project ${project}`),
    action("pair-claude", `Launch agent-pair-claude for ${taskId} in project ${project}`),
    action("pair-codex", `Launch agent-pair-codex for ${taskId} in project ${project}`),
```

After: 5 action buttons remain (t3code, agent-claude, agent-codex, revise, abandon), fitting in two ntfy notification batches at `maxActions=3` instead of three.

**Note:** If gh-ludics-43 lands first, this change is already done.

### Change 4: Remove orchestrated-mode helpers from notify.ts

**File:** `src/notify.ts`

Several functions exist solely to support agent-duo/pair session conclusion monitoring. With those adapters removed, these code paths become dead:

1. **`orchestratedModeFilter()`** (lines 446-456) — returns `"duo"` or `"pair"` for agent-duo/pair adapters. After removal, no adapter returns a non-null value. Remove the function entirely and replace callers with `null`.

2. **`normalizeSessionFeatureForTaskMatch()`** (lines 466-469) — strips `"pair-"` and `"duo-"` prefixes from session features. Only relevant for orchestrated sessions. Remove the function and replace callers with identity (return the feature unchanged).

3. **`conclusionStatusFiles()`** (lines 663-674) — returns status file names (`claude.status`, `codex.status`, `coder.status`) for orchestrated adapters. Returns `[]` for all remaining adapters. Remove the function; callers can use an empty array directly.

4. **Comments referencing agent-duo/pair** (lines 69-75, 800) — update or remove comments about `suggest-refactor` phase and agent-duo/pair status vocab. These constants (`SESSION_CONCLUSION_PHASE`, `SESSION_CONCLUDED_PHASES`, `SESSION_CONCLUDED_STATUSES`) may still be needed if t3code or agent-claude sessions use the same conclusion detection. Review whether they're still referenced in non-agent-duo code paths; if not, remove them.

### Change 5: Remove agent-duo from slot assignment logic

**File:** `src/slots/index.ts` (lines 175-178)

Remove the three agent-duo/pair cases from the session-handling switch:

```typescript
// DELETE (lines 175-178):
      case "agent-duo":
      case "agent-pair-codex":
      case "agent-pair-claude":
        session = "null";
        break;
```

The `default` case (line 181) already sets `session = String(slotNum)`, which is fine for all remaining adapters. The t3code case (line 174) also sets `session = "null"`, so it is unaffected.

### Change 6: Remove agent-duo from session sweep infrastructure

**File:** `src/sessions/sweep-state.ts`

1. Remove `"agent-duo"`, `"agent-pair-codex"`, `"agent-pair-claude"` from the `SweepMode` type union (line 10) and from `SWEEP_TARGET_MODES` set (lines 13-15).

2. In `defaultCleanupCommand()` (lines 72-76), remove the agent-duo and agent-pair cleanup command branches. After removal, only agent-claude and agent-codex remain.

After:
```typescript
export type SweepMode = "agent-claude" | "agent-codex";

export const SWEEP_TARGET_MODES = new Set<SweepMode>([
  "agent-claude",
  "agent-codex",
]);
```

**File:** `src/sessions/sweep.ts`

1. In `resolveProjectDirForSlot()` (line 36): remove the `preferPeerSync` check for agent-duo/agent-pair. After removal, `preferPeerSync` is always false (only agent-claude and agent-codex use `.agent-sessions/`, not `.peer-sync/`). Simplify to `const preferPeerSync = false;` or remove the variable.

2. In `matchesOrchestratedMode()` (lines 50-53): remove agent-duo/pair branches. With only agent-claude/agent-codex as sweep targets, this function always returns `true`. Inline `true` at call sites or keep as a no-op.

3. In `collectAttachedKeys()` (lines 97-103): remove the agent-duo/agent-pair branch that uses `listSessions()` with peer-sync mode matching. After removal, all sweep modes fall through to the provider-based cleanup name path.

4. In `knownSessionStillPresent()` (lines 123-125): remove the agent-duo/agent-pair branch that checks `listSessions()`.

**File:** `src/sessions/enrich.ts`

1. In `readOrchestration()` (lines 37-45): the entire function assigns `type` as `"agent-duo"`, `"agent-pair-codex"`, or `"agent-pair-claude"` based on `.peer-sync/` files. With those types removed from the `Orchestration` type union, this function's type assignments become invalid. The function should either be removed (if no remaining code calls it for non-orchestrated sessions) or simplified.

Check callers: `readOrchestration()` is called during session enrichment to populate `MergedSession.orchestration`. Since orchestrated sessions will no longer exist, the function and its callers should gracefully return `null` for sessions that don't have `.peer-sync/` state.

### Change 7: Remove agent-duo from Orchestration type

**File:** `src/types.ts` (line 19)

Remove the `Orchestration` type entirely, or remove the `type` field's union values:

Before:
```typescript
export interface Orchestration {
  type: "agent-duo" | "agent-pair-codex" | "agent-pair-claude";
  ...
}
```

Since no remaining adapter produces orchestration data, the `Orchestration` interface and its usage in `MergedSession` (line 38: `orchestration: Orchestration | null`) become dead. However, t3code sessions may eventually populate orchestration state. For now, mark the type field as a generic string to allow future expansion, or remove it if no code reads it outside the deleted agent-duo paths.

Recommended approach: keep the `Orchestration` interface but remove the specific type literals, making the `type` field a plain `string`. This preserves session reporting infrastructure for future adapters.

### Change 8: Remove agent-duo monitoring from Mag

**File:** `src/mag.ts`

1. **`NOTIFICATION_LAUNCH_ADAPTERS`** (lines 739-747): remove `"agent-duo"`, `"agent-pair-codex"`, `"agent-pair-claude"` from the set.

2. **`normalizeLaunchAdapter()`** (lines 749-753): change the fallback from `"agent-duo"` to `"t3code"` (or `"agent-claude"`). The fallback fires when an unrecognized adapter name is received from a notification button tap.

3. **`computeActiveUnconcludedAgentDuoSlots()`** (lines 1398-1446): delete this entire function. It filters slots by mode `"agent-duo"` and reports their orchestration phase/round. No remaining adapter uses this. Also remove its call site in briefing context generation (line 1273).

4. **`pollSessionConclusionNotifications()`** (lines 1936-1962): this function iterates slots with agent-duo/pair modes and calls `maybeNotifySessionConclusionForAdapter()`. With those modes removed, the filter at line 1943 will never match. Remove the function and its call site (line 2008 in `magStart()`), or update the mode filter to only match remaining adapters if t3code/agent-claude need conclusion monitoring.

5. **Comment at line 1037**: update "e.g. Launch agent-duo" to "e.g. Launch t3code".

6. **Line 1421/1430**: already covered by deleting `computeActiveUnconcludedAgentDuoSlots()`.

7. **Line 1943**: already covered by removing `pollSessionConclusionNotifications()`.

### Change 9: Remove agent-duo from agent-session adapter

**File:** `src/adapters/agent-session.ts` (line 211)

Change the hardcoded string `"Part of agent-duo session"` to a generic label like `"Part of orchestrated session"`, or remove the `.peer-sync` integration block entirely (lines 204-215). The `.peer-sync` directory presence check is specific to agent-duo-style sessions. Since those sessions no longer exist, this block is dead code. Remove it.

### Change 10: Update config templates

**File:** `templates/config.reference.yaml`

1. Remove agent-duo/pair from the adapter_profiles example (lines 24-27).
2. Remove agent-duo/pair from the "Available adapters" comment (lines 34-35).
3. Remove agent-duo/pair adapter config blocks (lines 47-55).

**File:** `templates/harness/config.yaml`

1. Remove the agent-duo project entry (lines 18-20).
2. Remove the agent-duo adapter config (lines 27-28).

**File:** `templates/slots.example.md`

1. Change the example slot mode from `agent-duo` to `t3code` or `agent-claude` (line 7).

### Change 11: Update documentation templates

**File:** `templates/harness/CLAUDE.md` (line 26)

Remove reference to `lukstafi/agent-duo` for adapter issues. Change to:
```
file a GitHub issue to the appropriate repo (e.g., `lukstafi/ludics` for harness/Mag issues).
```

**File:** `templates/mag/memory/workflows.md` (line 103)

Remove "Complex tasks: agent-duo (two agents)" from the adapter selection guidance. Update to reflect current adapters:
```
   - Complex tasks: t3code (thread-based sessions)
   - Medium tasks: agent-claude (single agent)
   - Simple tasks: manual or agent-claude
```

**File:** `templates/dashboard/terminals.html` (line 224)

Remove the agent-duo reference in the comment about terminal tabs. (This file may already be scheduled for removal by gh-ludics-40; coordinate.)

### Change 12: Update test expectations

**File:** `src/notify.test.ts`

1. Update `buildProposalNotificationActions` test: expected labels change from `["agent-duo", "pair-claude", "pair-codex", "t3code", "agent-claude", "agent-codex", "revise", "abandon"]` to `["t3code", "agent-claude", "agent-codex", "revise", "abandon"]`. Update body assertion indices accordingly.

2. Update `chunkNotificationActions` test: chunks change from `[3, 3, 2]` to `[3, 2]`.

## Files Modified (summary)

| File | Action |
|------|--------|
| `src/adapters/agent-duo.ts` | **Delete** |
| `src/adapters/agent-pair-claude.ts` | **Delete** |
| `src/adapters/agent-pair-codex.ts` | **Delete** |
| `src/adapters/orchestrated-adapter.ts` | **Delete** |
| `src/adapters/index.ts` | Remove 3 imports + 3 registry entries |
| `src/notify.ts` | Remove 3 action buttons, remove/simplify orchestrated-mode helpers |
| `src/notify.test.ts` | Update expected labels and chunk sizes |
| `src/slots/index.ts` | Remove 3 cases from session-handling switch |
| `src/sessions/sweep-state.ts` | Remove 3 modes from SweepMode union and cleanup commands |
| `src/sessions/sweep.ts` | Remove agent-duo/pair branches from 4 functions |
| `src/sessions/enrich.ts` | Simplify/remove orchestration type assignment |
| `src/types.ts` | Remove/generalize Orchestration type literals |
| `src/adapters/agent-session.ts` | Remove .peer-sync integration block |
| `src/mag.ts` | Remove 3 adapter names, delete duo-monitoring function, update fallback |
| `templates/config.reference.yaml` | Remove duo/pair adapter examples and config blocks |
| `templates/harness/config.yaml` | Remove duo project and adapter entries |
| `templates/slots.example.md` | Change example mode from agent-duo to t3code |
| `templates/harness/CLAUDE.md` | Remove agent-duo repo reference |
| `templates/mag/memory/workflows.md` | Update adapter selection guidance |
| `templates/dashboard/terminals.html` | Remove agent-duo comment reference |

## Test Plan

1. **Unit: `buildProposalNotificationActions` returns 5 actions** — t3code, agent-claude, agent-codex, revise, abandon.
2. **Unit: `chunkNotificationActions` chunks 5 items at maxActions=3** — produces `[3, 2]`.
3. **Build: `bun build` succeeds with no import errors** — confirms all deleted modules are unlinked.
4. **Manual: slot assign with t3code adapter** — verify session handling falls through to `"null"` correctly.
5. **Manual: slot assign with agent-claude adapter** — verify session handling sets `String(slotNum)`.
6. **Manual: `ludics sessions sweep`** — verify sweep runs without errors after SweepMode narrowing.
7. **Manual: `ludics mag start`** — verify keepalive path works without `pollSessionConclusionNotifications()`.
8. **Manual: notification Launch button tap** — verify t3code/agent-claude launches still work end-to-end.
9. **Regression: `ludics sessions report`** — verify session enrichment doesn't crash when encountering old `.peer-sync/` directories in project repos (should return `orchestration: null`).

## Risk Assessment

- **Low risk.** All removed code is specific to the discontinued agent-duo CLI. No remaining adapter or workflow depends on it.
- **Stale `.peer-sync/` directories.** Existing projects may still have `.peer-sync/` directories from old agent-duo sessions. Session enrichment should gracefully ignore these (return `null` orchestration) rather than crash. The `readOrchestration()` change must handle this.
- **Config migration.** Users with `agent-duo` in their `config.yaml` adapters section will get a harmless no-op entry. No runtime error — the adapter registry simply won't have the key, and no slot assignment uses it. A console warning on unrecognized adapter names would be a nice-to-have but is not required for this change.
- **Coordination with gh-ludics-43.** The notification button removal overlaps. If gh-ludics-43 lands first, Change 3 in this proposal is a no-op (already done). If this proposal lands first, gh-ludics-43's Change 2 is a no-op. No conflict either way.
