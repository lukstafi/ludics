# Audit: string→union widenings for missing boundary validators

**Task**: gh-ludics-411
**Related**: task-4cd94043 (the `parseSlotLiveness` worked example), gh-ludics-410 (defense-in-depth anti-pattern — guides where NOT to add validators)

## Goal

`SlotData.liveness` was widened from `string | null` to the narrowed enum
`SlotLiveness = "alive" | "interrupted" | "escalated" | null` in
task-4cd94043. Round 1 of that work missed external-input write sites
because `tsc` only checks TypeScript-internal assignments — at any
external boundary (HTTP body, frontmatter parse, JSON-on-disk, env-var)
the compiler silently trusts whatever string flows in. Round 2 patched
this with a `parseSlotLiveness()` runtime validator co-located with the
type, called at `src/cluster-http.ts` (HTTP body deserializer) and
`src/slots/migration.ts` (markdown migration parser).

The pattern almost certainly applies to other narrowed string unions in
the codebase. **This audit identifies the unprotected external boundaries
and adds `parseX()` validators where missing.** The deliverable is code
plus tests, not a doc memo.

Issue: https://github.com/lukstafi/ludics/issues/411

## Acceptance Criteria

1. **Validator added at `PendingIntent.action` JSON read sites.**
   - The four call sites in `src/cluster-http.ts` that do
     `JSON.parse(...) as PendingIntent` (`getIntentForDashboard`,
     `getIntentsForMachine`, `expireStaleIntents`, and the GET
     `/api/cluster/intents` handler around line 532) are external
     boundaries: another machine's keepalive deposits these JSON files,
     and the consumer treats `intent.action` as the union
     `"start" | "stop" | "resume"` then dispatches via `switch` in
     `src/mag.ts::workerKeepalive`. An invalid `action` silently falls
     through every case.
   - Add `parsePendingIntentAction(raw: unknown): "start" | "stop" | "resume" | null`
     co-located with the `PendingIntent` interface in `src/cluster-http.ts`.
     On invalid value, return `null` and have callers skip the intent
     (the file is auto-expired by the existing 15-minute TTL anyway —
     "skip and let TTL clean it up" is the right safe default for
     orchestration intents). Validator must also call `parseInt(epoch)`
     and machine/taskId string-coerce so a single function returns either
     a fully-validated `PendingIntent` or `null`. Rename to
     `parsePendingIntent` if the function ends up doing the whole struct.
   - Update the `switch (intent.action)` site in
     `src/mag.ts::workerKeepalive` to use the validated value.

2. **Validator added at `SourceKind` external read in `src/sessions/discover-codex.ts`.**
   - Line 175 has `source: source as SourceKind` where `source` is read
     from a Codex `session_meta` JSONL file (external process writes
     these). The cast is unchecked — an unknown source string lands in
     `DiscoveredSession.source` and downstream UI/sort logic silently
     ignores it.
   - Add `parseSourceKind(raw: unknown): SourceKind` co-located with
     `SourceKind` in `src/types.ts`. Default-to-safe: unknown collapses
     to `"unknown"` (the existing fallback already used at line 144 and
     line 153 of `discover-claude.ts`). Replace the bare cast at line
     175 with the validator.

3. **OrchestrationState union read sites get a single struct-level validator.**
   - `src/orchestration/state.ts::readOrchestrationState` does
     `readJsonFile<OrchestrationState>(...)` — five string unions inside
     `OrchestrationState` are read without validation:
     - `mode: "duo" | "pair" | "solo"` (line 125)
     - `backend?: "t3code" | "tmux"` (line 172)
     - `agents[].provider: T3ProviderKind` (`"codex" | "claude-code"`)
     - `agents[].role?: "coder" | "reviewer"`
     - `agentStates[k].turnLifecycle.state: "dispatched" | "starting" | "running" | "settled" | "error"`
     - `agentStates[k].turnLifecycle.completionSource: "snapshot" | "stop-hook" | "timeout" | null`
   - Pragmatic single-validator approach: extend the existing
     `migrateState()` function (already runs on every read) to whitelist-
     check each of these fields and `console.error` + skip-or-coerce on
     unknown values. This is appropriate because the file is written by
     this same process — corruption is the realistic threat, not foreign
     input — so a noisy log + coerce-to-default is the right policy.
   - Per-field choice rationale (document in implementation):
     `mode` → throw (invariant; corrupt state should not silently run);
     `backend` → coerce to `globalAdapter()` (the existing fallback
     elsewhere); `provider` → throw (wire-protocol-bound, can't guess);
     `role` → drop the field (downstream code already handles
     `role === undefined`); lifecycle `state` and `completionSource` →
     coerce to `"error"` and `null` respectively (the closest safe
     defaults).

4. **No redundant validators added at internal write sites.**
   - The audit population is *external* boundaries only. Do not add
     `parseX()` calls at internal struct construction sites — `tsc` is
     load-bearing there. Specifically, do not touch:
     `src/dashboard.ts::computeSlotLiveness` (returns the union by
     construction); `src/orchestration/effort.ts::normaliseEffortLevel`
     (already a parser); `src/sessions/sweep-state.ts` (already
     whitelist-checks via `SWEEP_TARGET_MODES.has`); `src/config.ts`
     (already validates `adapter` against `"t3code" | "tmux"` at lines
     236-242); `src/retrospective.ts::parseVerdictFromContent` (already
     a parser).

5. **Each new validator has a unit test.**
   - Test pattern matches `parseSlotLiveness`'s test in
     `src/slots/json.test.ts:179-193`: one test case per validator
     covering `(valid, valid-after-trim, null, undefined, empty-string,
     unknown-string, non-string)`. Place tests in the file colocated
     with the type definition (e.g. `src/cluster-http.test.ts`,
     `src/types.test.ts`). For the OrchestrationState struct-level
     validator in `migrateState`, add a single regression test that
     loads a state file with a corrupted enum value and asserts the
     coerce/throw behavior matches the documented per-field policy.

6. **Audit summary in the implementation PR description.**
   - The PR description (not a doc file) lists each union audited, the
     external boundaries found, and either the validator added or the
     reason it was skipped (e.g. "already covered by
     `SWEEP_TARGET_MODES.has`"). This makes the audit complete-and-
     reviewable without committing a doc memo (per resolved Q2).

## Context

### The pattern (worked example)

`src/slots/types.ts` defines:

```typescript
export type SlotLiveness = "alive" | "interrupted" | "escalated" | null;

export function parseSlotLiveness(raw: unknown): SlotLiveness {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (s === "alive" || s === "interrupted" || s === "escalated") return s;
  return null;
}
```

Called at `src/slots/migration.ts` (frontmatter→JSON migration boundary)
and `src/cluster-http.ts::handlePostSlotUpdate` (HTTP-body→`SlotData`
boundary). Test in `src/slots/json.test.ts`. The audit replicates this
shape for the unions identified in the Acceptance Criteria.

### Inventory (audit step 1)

The codebase has 21 named string union type aliases (from
`rg '^(export )?type [A-Z]\w* = ' src/ | rg '"'`) plus 60 inline
union annotations on interface members. **Most are not external-
boundary-read** — they're internal-only types whose values are
constructed by code that `tsc` already type-checks. The audit found
the following that ARE read at external boundaries:

| Type | Defined at | External read site | Status before audit |
|------|------------|-------------------|---------------------|
| `SlotLiveness` | `src/slots/types.ts` | HTTP body, markdown migration | Has `parseSlotLiveness` (the worked example) |
| `PendingIntent.action` (`"start" \| "stop" \| "resume"`) | `src/cluster-http.ts` | JSON file read by other-machine keepalive | **Missing** — addressed by AC 1 |
| `SourceKind` | `src/types.ts` | Codex session JSONL | **Missing** — addressed by AC 2 |
| `OrchestrationState.mode` / `.backend` / `agents[].provider` / `agents[].role` / `agentStates[].turnLifecycle.state` / `.completionSource` | `src/orchestration/state.ts` | `readJsonFile` of slot JSON | **Missing** — addressed by AC 3 |
| `GlobalAdapterMode` | `src/config.ts` | `config.yaml` | **Already validated** at lines 236-242 (`if (rawAdapter === "t3code" || rawAdapter === "tmux")`) |
| `SweepMode` | `src/sessions/sweep-state.ts` | `known-sessions.json` | **Already validated** via `SWEEP_TARGET_MODES.has` whitelist at line 92 |
| `UnifiedEffort` | `src/orchestration/effort.ts` | task frontmatter / config | **Already validated** via `normaliseEffortLevel` |
| Verdict (`"approve" \| "request_changes" \| "timeout"`) | `src/retrospective.ts` | review markdown content | **Already validated** via `parseVerdictFromContent` |

Unions excluded from the audit population (internal-only, no external
read site): `QueuePromoteResult`, `VerificationDecision`, `PhaseCategory`,
`PlanFileType`, `ReviewFileType`, `AgentType`, all `T3*` types defined
in `src/t3code/types.ts` (the t3code WebSocket client treats incoming
snapshots as opaque JSON for the dashboard view — failures show up as
ignored data, not silent enum miscoercion), `ConsoleChannel`, plus the
many inline `"coder" | "reviewer"`-style annotations whose values are
either constructed by typed code or already validated by sibling
function arguments.

### Task-frontmatter unions are NOT in scope (false-positive)

The original task description listed task `status`, `priority`, `effort`,
`adapter` as candidates. Verification: `src/tasks/types.ts` declares all
four as plain `string` (not narrowed unions). The legal values are
documented in inline comments only. So these fields are not
string→union *widenings* at all — they're just `string`. They are
candidates for a separate "narrow these types" task, but adding
boundary validators without first narrowing the type would be
defense-in-depth at internal-write sites — exactly the gh-ludics-410
anti-pattern. **Excluded from this audit's scope.**

### Default-to-safe vs. throw decision (resolved Q3)

Per-union, per-boundary. The Acceptance Criteria fix the choice for each
new validator. Rationales captured inline in AC 1, AC 3 so the
implementation is unambiguous. No uniform policy is imposed.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Implement the validators in the order of the Acceptance Criteria
   (AC 1, AC 2, AC 3). Each AC is a self-contained code change with its
   own test. Do not bundle them into a single mega-commit — the audit
   is small enough to land as one PR but the diff stays readable when
   each validator is its own commit.

2. AC 3's `migrateState` extension is the trickiest because it touches
   six fields. Suggested: factor a small `validateAndCoerce<T>(value:
   unknown, allowed: readonly T[], policy: "throw" | "coerce", fallback:
   T): T` helper local to `state.ts` so each field's call is a one-liner
   with the policy explicit at the use site.

3. Run `bun test` after each validator lands. Run `bun lint` and
   `bun build` once at the end. No new dependencies.

4. The existing CI lint check from gh-ludics-410 (boundary-validator
   linter, if landed) should not flag any of the new validators, since
   they are all at the documented external boundaries (HTTP body,
   JSON read, JSONL parse) — confirm at PR-create time.

## Scope

### In scope

- New `parseX()` validators for the three identified unprotected
  external-boundary unions (AC 1, AC 2, AC 3).
- One unit test per new validator (AC 5).
- Audit summary in the PR description (AC 6).

### Out of scope

- Doc entry in `docs/orchestration-patterns.md` (resolved Q2: skip).
- Numeric / boolean union widenings (TypeScript's coercion at JSON
  boundaries is well-understood; not the same failure mode).
- Narrowing `TaskFrontmatter` fields (`status`, `priority`, `effort`,
  `adapter`) from `string` to enum — separate task.
- Refactoring inline whitelist checks (e.g. `SWEEP_TARGET_MODES.has`,
  `parseVerdictFromContent`, `normaliseEffortLevel`) to the
  `parseX()` shape — they already work; pure stylistic churn would
  expand the diff without preventing bugs.
- Adding redundant validators at internal write sites (the
  gh-ludics-410 anti-pattern).
