# Add `tiny` effort level and `solo` workflow mode

## Goal

Introduce two related additions to the orchestration vocabulary:

1. A new task effort level **`tiny`** below `small`, for minimal changes (one-line fixes, doc tweaks, targeted lints) that don't need exploratory design.
2. A new workflow mode **`solo`** alongside `duo` and `pair`, in which a single coder agent runs the full lifecycle with no reviewer: `setup → work → pr-create → pr-comments → final-merge → retrospective`. No plan, no work-review loop, no suggest-refactor.

The natural pairing is **tiny → solo** (auto-selected at deferred-launch time). The two mechanisms remain independent: `tiny` effort with explicit `--pair` override is legal, and `solo` mode at medium effort (explicit `--solo`) is legal.

Source: user request, 2026-04-22 (no GitHub issue). All seven elaboration questions resolved by the user on the same date.

## Acceptance Criteria

### Mode type widened to `"duo" | "pair" | "solo"`

- [ ] Update the `mode` union in all seven locations: `OrchestrationRef.mode` and `OrchestrationState.mode` (`src/orchestration/state.ts`), `TmuxSlotState.orchestration.mode` (`src/adapters/tmux-adapter.ts`), `ParsedOrchestrationArgs.mode` and the `stop()` stub-entry in `src/adapters/t3code.ts`, `initPeerSync` parameter (`src/orchestration/peer-sync.ts`), `createWorktrees` / `cleanupWorktrees` (`src/orchestration/worktrees.ts`), `CleanupEntry.mode` (`src/orchestration/deferred-cleanup.ts`), `resolveTemplatePath` (`src/orchestration/skills.ts`).
- [ ] `migrateState()` includes a guard analogous to the existing legacy-duo warning: `mode === "solo"` must imply `duoPeerSlot == null` and `agents.length === 1`.
- [ ] Existing slot-state files (`orchestration/slot-{N}.json`) without `"solo"` are unaffected (backwards compatible on read).

### Solo phase graph

- [ ] `evaluateTransition` in `src/orchestration/phases.ts` produces the sequence `setup → work → [update-docs?] → pr-create → pr-comments → final-merge → done` when `mode === "solo"`.
- [ ] `plan`, `plan-merge`, `plan-review`, `review`, `gather`, `clarify`, `pushback`, `suggest-refactor` are skipped in solo mode. Preferred implementation: drop entirely from the solo traversal. Fallback: if dropping `plan` adds meaningful complexity to `evaluateTransition`, keep it as an always-skipped pass-through (acceptable per resolved question #1).
- [ ] `update-docs` is **kept** in solo, interval-gated by the existing `shouldRunUpdateDocs` helper (resolved question #5). The `work → update-docs → pr-create → pr-comments` learning-bookkeeping chain continues to apply.
- [ ] The existing `case "work"` → `review` transition in duo/pair is not reached in solo; solo's `work` transitions directly toward `pr-create` (via `update-docs` when due).
- [ ] No new `Phase` enum members are added — solo traverses a subset of the existing `Phase` union. Dashboard and journal phase consumers need no schema change.

### Agent participation

- [ ] `agentParticipatesInPhase` in `src/orchestration/phases.ts` returns `false` for any agent with `role === "reviewer"` in every solo phase (no reviewer is ever spawned).
- [ ] For `mode === "solo"`, the coder participates in every non-`setup`/`done` phase that is part of the solo graph.
- [ ] The `merge-*` branches remain gated on `duoPeerSlot != null` and therefore already return `false` for solo without change.

### Adapter sessions (single thread, single tmux window)

- [ ] `parseT3CodeAdapterArgs` in `src/adapters/t3code.ts` accepts a new `--solo` flag (sibling to `--pair` / `--duo`). `--solo` takes one `--coder provider:model:name` token and no `--reviewer`. Sets `mode = "solo"` and produces an `agents` array of length 1 with `role: "coder"`.
- [ ] `--solo` combined with `--reviewer …` or `--duo-peer-slot=N` is rejected at parse time with a clear error.
- [ ] `tmux-adapter.ts` loops over `agents` once for solo; only the coder ttyd port is opened; `agentPortRole` falls back to index-0 → `"coder"`.
- [ ] Both adapters thread `orchestration.mode === "solo"` through to `createWorktrees()` and `initPeerSync()`.

### Worktree layout

- [ ] `createWorktrees` in `src/orchestration/worktrees.ts` treats `"solo"` identically to `"pair"`: the single coder uses the root worktree; no `_build_review*` sibling is created.
- [ ] `cleanupWorktrees` correctly handles solo (fall-through to root-only removal, no per-agent loop).

### Template resolution (Option A, minimal)

Resolved question #3: introduce `solo-<phase>.md` overrides, but only where the pair-coder template genuinely mentions a reviewer.

- [ ] `resolveTemplatePath` in `src/orchestration/skills.ts` adds a solo branch when `mode === "solo"`:
      `solo-<phase>.md > pair-coder-<phase>.md > <phase>.md` (and the existing `hasUpstream` variants stay ahead of each tier).
- [ ] Create `skills/orchestration/solo-work.md` — `pair-coder-work.md` contains "Reviewer guidance from prior round" and a pair-specific bail-out contract (writes `bail-out|…` expecting `bail-out-confirmed` from the reviewer). Solo's `work.md` omits reviewer guidance and treats `bail-out|…` as terminal.
- [ ] Do **not** create `solo-plan.md`, `solo-plan-merge.md`, `solo-clarify.md` — these phases are not reachable in solo mode.
- [ ] Do **not** create `solo-pr-create.md`, `solo-update-docs.md`, `solo-pr-comments.md`, `solo-final-merge.md` — the existing generic templates (`pr-create.md`, `update-docs.md`, `pr-comments.md`, `final-merge.md`) are mode-agnostic and can be reused via the non-pair fallback. (The "reviewer" mentions in `pr-comments.md` refer to human GitHub reviewers, not the peer agent.)

### Solo bail-out

- [ ] Introduce `isSoloBailedOut(state)` or extend `isPairBailedOut` to return `true` when `mode === "solo"` and the coder status is `bail-out|…`. The `evaluateTransition` `case "work"` branch consults this to transition solo work to `done` on bail-out.
- [ ] `solo-work.md`'s bail-out instruction writes `bail-out|<timestamp>|<reason>` to the status file; the runner accepts it as terminal without expecting `bail-out-confirmed`.

### Runner transitions

- [ ] Any runner path that today fires only on `work → update-docs` when `!shouldRunUpdateDocs` (e.g. the `maybeOverrideTransition` override around `review → update-docs`) is also exercised for solo's `work → update-docs → pr-create` sequence. Solo's learning-gate behaviour matches duo/pair when `update-docs` fires or is skipped.
- [ ] Pair-specific runner branches (plan-copy in `applyPhaseSideEffects`, verdict-notification blocks, pair auto-commit) remain guarded on `state.mode === "pair"` and don't fire for solo. No regression.
- [ ] `pushBeforePhases` still includes `pr-create` and `final-merge` and therefore covers solo unchanged.

### Effort level `tiny`

- [ ] `TaskFrontmatter.effort` comment in `src/tasks/types.ts` updated to `// tiny, small, medium, large`.
- [ ] `src/dashboard-server.ts` task-create endpoint allowlist (currently `["small", "medium", "large"]`) accepts `"tiny"`.
- [ ] Existing defaults (`src/mag.ts`, `src/tasks/markdown.ts`) are left alone — `"tiny"` is a deliberate downward choice, not a default.
- [ ] `selectOrchestrationFlags` in `src/adapters/t3code.ts`:
      - When `effort === "tiny"`: emits `--solo --coder claude:claude-sonnet-4-6:coder` (model stays Sonnet per resolved question #2), no `--plan`, no `--gather`, no `--pair`.
      - Existing behaviour for small / medium / large is unchanged.

### Auto-selection policy: `tiny` → `solo`

Resolved question #4: unconditional; the broader `orchCfg.default_mode` precedence concern is out of scope (captured in Notes as a follow-up).

- [ ] `selectOrchestrationFlagsForTask` (or wherever `selectOrchestrationFlags` is called in the deferred-launch / auto-start path) returns `isDuo: false` and `--solo` args when `effort === "tiny"`, regardless of `orchCfg.default_mode`.
- [ ] User can still override with explicit `-A "--pair …"` or `-A "--duo-peer-slot=N"`.
- [ ] `maybeFillEmptySlots` and `evaluateAutoStartDecisionPure` require no change (already agnostic to the coder/reviewer split; solo is single-slot so it falls through the non-duo branch).

### `has_questions` gate preserved

- [ ] `has_questions: true` continues to block proposal generation in solo/tiny just as in pair/duo (resolved question #7). No bypass.

### Briefing section rename

Resolved question #6: rename to mode-agnostic.

- [ ] Rename "Active Unconcluded Agent-Duo Slots" to "Active Unconcluded Slots" (or equivalent mode-agnostic wording) wherever it appears in:
      - `skills/ludics-briefing.md` (briefing-authoring skill)
      - The `briefing-context` generator in the source (if the section is emitted by code; otherwise only the skill text changes)
      - Any fixture or snapshot asserting on that section header
- [ ] Solo slots appear in the renamed section alongside pair/duo slots — no separate "Solo Slots" subsection needed.

### Tests

- [ ] `src/orchestration/phases.test.ts`: add solo-mode cases for `agentParticipatesInPhase` (reviewer always false, coder participates in all solo phases) and `evaluateTransition` (work → pr-create / work → update-docs → pr-create; plan and review phases unreachable).
- [ ] `src/orchestration/skills.test.ts`: add solo template resolution tests — `solo-work.md` takes precedence for phase `work`, and `pair-coder-<phase>.md` / `<phase>.md` fallbacks are reached for phases that have no solo variant.
- [ ] `src/orchestration/worktrees.test.ts`: add solo creation test (single worktree, no per-agent sibling).
- [ ] `src/adapters/t3code.test.ts`: add `--solo` flag parsing test, including rejection of `--solo --reviewer …` and `--solo --duo-peer-slot=N`.
- [ ] `src/tasks/markdown.test.ts`: add `effort: tiny` round-trip test.
- [ ] Any existing test asserting `mode: "duo" | "pair"` as a type annotation or runtime check widens to accept `"solo"`. (Grep showed ~45 occurrences; most are type annotations that update automatically.)
- [ ] No regression in duo or pair behaviour — existing tests continue to pass unchanged.

### Documentation

- [ ] Any in-repo docs that enumerate modes or effort levels (e.g. AGENTS.md, adapter help text, CLI `--help` strings) mention `solo` and `tiny`. Keep the bar low — enough that a reader can discover them without reading source.

## Context

### Mode union

- `src/orchestration/state.ts`: `OrchestrationRef.mode` and `OrchestrationState.mode` are `"duo" | "pair"`. `migrateState()` warns on `mode === "duo" && duoPeerSlot == null` as legacy; solo needs an analogous invariant (`solo` implies `duoPeerSlot == null` and `agents.length === 1`).
- `src/adapters/tmux-adapter.ts`: `TmuxSlotState.orchestration.mode`.
- `src/adapters/t3code.ts`: `ParsedOrchestrationArgs.mode` is pinned to the literal `"pair"` in one branch; `--duo` / `--pair` handlers set it explicitly; the `stop()` function writes `mode: "pair"` into the stub entry for non-orchestrated threads.
- `src/orchestration/peer-sync.ts`: `initPeerSync(..., mode, ...)` parameter — writes `peer-sync/mode` and into `state.json`. Also writes `{agent.name}.status` per agent (solo writes one) and `coder-agent` / `reviewer-agent` provider files (solo skips `reviewer-agent`).
- `src/orchestration/worktrees.ts`: `createWorktrees(..., mode)` and `cleanupWorktrees(..., mode)`.
- `src/orchestration/deferred-cleanup.ts`: `CleanupEntry.mode`.
- `src/orchestration/skills.ts`: `resolveTemplatePath(phase, mode, role?, hasUpstream?)`. Current precedence when `hasUpstream`: `pair-<role>-upstream-<phase>.md > upstream-<phase>.md > pair-<role>-<phase>.md > <phase>.md`.

### Phase graph and transitions

- `src/orchestration/phases.ts`: `evaluateTransition` is a pure function of `state`; each `case` should start with a `mode === "solo"` short-circuit before the existing pair/duo branches. `agentParticipatesInPhase` is the other mode-sensitive helper.
- The existing reviewer-skipped-plan copy logic in `evaluateTransition` (`case "plan-merge"`, around lines 467–481) is orthogonal to solo — it handles "pair mode, reviewer didn't produce a plan". Solo short-circuits out of `case "plan"` before reaching `plan-merge` at all (or doesn't visit `plan` — see resolved question #1).
- `src/orchestration/runner.ts`: `maybeOverrideTransition`, `applyPhaseSideEffects`, and the verdict-notification blocks guard on `state.mode === "pair"`; solo won't trigger these. The `review → update-docs` override (around line 1420) that fires when `!shouldRunUpdateDocs` is the main runner path that needs a solo equivalent for the `work → update-docs → pr-create` chain.
- `pushBeforePhases` already includes `pr-create` and `final-merge`.
- `isPairBailedOut(state)` in `phases.ts` checks both coder and reviewer statuses. Solo needs either a new `isSoloBailedOut` helper or an extension that treats `mode === "solo"` with coder status `bail-out` as bailed out.

### Adapter flags

- `parseT3CodeAdapterArgs` currently handles `--duo` and `--pair` with `--coder provider:model:name` and `--reviewer provider:model:name` tokens. The `start()` function loops `for (agent of agents)` to spawn threads — solo reuses this unchanged, just runs once.
- Validation: `--solo --reviewer …` should throw; `--solo --duo-peer-slot=N` should throw.

### Worktrees

- `createWorktrees` today branches: `"pair"` (both agents share the root worktree / root branch) vs `"duo"` default (each agent gets `{stem}-{agentSlug}` worktree and branch). Solo's single agent treats `"solo"` identically to `"pair"` — single worktree at root, PR from the root branch.
- `cleanupWorktrees` has `if (mode === "duo")` for per-agent worktree removal; solo falls through to root-only removal, which is correct for pair-style layout.

### Template resolution

- `skills/orchestration/` current templates (post-d1932b8f, assuming `forward-pr.md` and `upstream-final-merge.md` are removed):
  - Mode-agnostic: `final-merge.md`, `pr-create.md`, `pr-comments.md`, `update-docs.md`, `suggest-refactor.md` (unused in solo), merge family.
  - Pair-coder: `pair-coder-plan.md`, `pair-coder-plan-merge.md`, `pair-coder-work.md`, `pair-coder-update-docs.md`, `pair-coder-pr-create.md`, `pair-coder-clarify.md`.
  - Pair-reviewer: `pair-reviewer-*.md` (entire family unused in solo).
- A grep for "reviewer" across the pair-coder and mode-agnostic templates (excluding `pr-comments.md`, where "reviewer" means a human GitHub reviewer) shows only `pair-coder-work.md`, `pair-coder-plan.md`, and `pair-coder-plan-merge.md` genuinely depend on a paired reviewer. Since solo skips plan and plan-merge, only `pair-coder-work.md` needs a solo variant.
- `pair-coder-work.md` specifics the solo variant must drop:
  - "Reviewer guidance from prior round:" preamble and any reviewer-guidance placeholder.
  - The pair bail-out contract that expects `bail-out-confirmed` from the reviewer. Solo's contract: coder writes `bail-out|<ts>|<reason>`, runner terminates the phase.
- `pair-coder-pr-create.md` and `pair-coder-update-docs.md` don't reference a reviewer — the generic `pr-create.md` and `update-docs.md` already cover the solo case via the non-pair fallback.

### Effort and auto-selection

- `TaskFrontmatter.effort` (`src/tasks/types.ts`) is `string; // small, medium, large` — free-form, unvalidated at parse time in `parseTaskFrontmatter` (`src/tasks/markdown.ts`).
- Defaults: `src/mag.ts` (two spots) defaults to `"small"`; `src/tasks/markdown.ts` defaults to `"medium"`; `src/dashboard-server.ts` (task-create endpoint) accepts `["small", "medium", "large"]` and falls back to `"medium"`. Only the dashboard allowlist needs updating.
- `selectOrchestrationFlags` in `src/adapters/t3code.ts`: effort drives (a) coder model (opus for medium/large, sonnet otherwise) and (b) pre-work phase flags (`--plan` for medium+, `--plan --gather` for large). Add a `norm === "tiny"` early-return that emits `--solo --coder claude:claude-sonnet-4-6:coder` and no pre-work phases.

### Briefing

- The "Active Unconcluded Agent-Duo Slots" string appears in `skills/ludics-briefing.md` and may also appear in the source generator for `mag/briefing-context.md`. Rename both the skill-side wording and any source emission to mode-agnostic.

### Retrospective

- Retrospectives are collected post-`done` via `ludics-verify-completion` + a dashboard action — they are not part of the `Phase` union. Solo inherits retrospective collection unchanged; no code change needed to "keep retrospective".

## Approach

*Suggested approach — agents may deviate if they find a better path.*

A reasonable order of operations:

1. **Widen the type.** Change `"duo" | "pair"` to `"duo" | "pair" | "solo"` in all seven locations. TypeScript's exhaustiveness checks fan out as a to-do list.
2. **Phase graph.** Add a `mode === "solo"` short-circuit at the top of each relevant `case` in `evaluateTransition`. Dropping `plan` entirely is preferred; if the short-circuit is cleaner as "skip everything except `setup → work → [update-docs?] → pr-create → pr-comments → final-merge → done`", implement that as a separate function `evaluateTransitionSolo(state)` dispatched at the top of `evaluateTransition`.
3. **`agentParticipatesInPhase`**: add a top-level `if (state.mode === "solo") return agent.role === "coder" && phase !== "setup" && phase !== "done"` (or the inverse for the handful of phases solo doesn't visit).
4. **Bail-out**: extend `isPairBailedOut` or add `isSoloBailedOut`. Thread through `case "work"`.
5. **Adapter flag**: add `--solo` parsing to `parseT3CodeAdapterArgs`; reject conflicting flags.
6. **Worktrees**: extend the `mode === "pair"` branch in `createWorktrees` to also match `"solo"`.
7. **Template resolution**: extend `resolveTemplatePath` with a solo branch; add `solo-work.md`. Defer to 21b4c850's principles-with-rationale style if that task has already landed; otherwise write the template in the current style and note for 21b4c850 follow-up.
8. **Effort + auto-selection**: add the `norm === "tiny"` early-return in `selectOrchestrationFlags`; add `"tiny"` to the dashboard allowlist; update the type comment.
9. **Briefing rename**: rename the section header in `ludics-briefing.md` and any source emission.
10. **Tests**: add focused solo-mode tests and widen type assertions. The grep-for-mode-literals catches the long tail.

Sequence relative to related tasks:

- **Wait for `task-d1932b8f`** (simplify upstream workflow) to land first — it removes `forward-pr` and `upstream-final-merge.md`, so solo's phase graph targets a simpler post-d1932b8f tree. If for some reason the two overlap, solo's `evaluateTransition` short-circuits don't touch the upstream logic, so the merge should be mechanical.
- **Prefer `task-21b4c850`** (template principles refactor) to land first — then `solo-work.md` inherits the new style from the start and no conversion pass is needed later. If this task lands first, expect a follow-up style pass when 21b4c850 lands.

## Scope

### In scope

- Widen `mode` union to include `"solo"` across source and tests.
- Implement solo phase graph, agent participation, worktree layout, template resolution.
- Add `tiny` effort level (allowlist, type comment) and its auto-selection mapping to solo.
- Rename the briefing "Agent-Duo" section to mode-agnostic.
- Solo bail-out contract and `solo-work.md` template.

### Out of scope

- **Broader `orchCfg.default_mode` precedence cleanup.** Configuration-as-override vs configuration-as-fallback is a separate design question (captured in the task Notes as a follow-up).
- **Proposal-less direct launch for tiny.** `has_questions: true` continues to block proposal generation; there is no express lane for tiny tasks to bypass the proposal gate.
- **Changes to existing pair/duo template style.** Principles-with-rationale rewrites belong to `task-21b4c850`. This task's `solo-work.md` should match whatever style is current when it lands (and be updated by 21b4c850's follow-up pass if that task lands later).
- **New `Phase` enum members.** Solo traverses a subset of the existing `Phase` union.
- **Haiku model for tiny.** The elaboration considered it; the user chose to keep Sonnet for both `small` and `tiny` (resolved question #2).

### Dependencies

- `task-d1932b8f` (simplify upstream workflow): should land first; solo's phase graph targets the already-simplified post-d1932b8f state.
- `task-21b4c850` (template principles refactor): preferred to land first so `solo-work.md` inherits the new style; not strictly blocking.
