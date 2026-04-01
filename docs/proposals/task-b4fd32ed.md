# Replace duo mode pre-PR path with hierarchical duo

## Goal

The current duo mode maintains a separate pre-PR code path (plan loop, code-review loop with both agents coding and reviewing, PR creation) alongside pair mode. This is a maintenance burden -- duo-only pre-PR logic gets less exercise and testing than pair mode.

Hierarchical duo replaces the separate pre-PR path with two independent pair-mode slots running on the same task with swapped agent assignments. Each slot produces a PR via the well-tested pair-mode machinery, then the existing merge phases compare and combine the results.

## Acceptance Criteria

- Duo mode's separate pre-PR code path is removed: the `mode === "duo"` branches in `agentParticipatesInPhase()`, `evaluateTransition()`, `buildSkillContext()`, and `composeSkillMessage()` that diverge from pair mode before the merge phases are eliminated.
- Generic (non-pair-prefixed) skill templates that served as duo-only pre-PR templates (`work.md`, `review.md`, `plan.md`, `clarify.md`, `plan-review.md`) are either removed or consolidated with their pair-mode counterparts, so there is a single template per phase per role.
- When a task is configured for duo mode (`mode: duo`), `maybeFillEmptySlots()` reserves **two** empty slots and assigns both to the same task with pair-mode orchestration but swapped agent assignments (Slot A: coder=claude, reviewer=codex; Slot B: coder=codex, reviewer=claude).
- Each slot runs standard pair-mode phases independently (gather, clarify, pushback, plan, plan-merge, plan-review, work, review, update-docs, pr-create, pr-comments) up to PR creation.
- After both slots have PRs, a cross-slot merge phase is triggered using the existing merge-vote / merge-debate / merge-execute / merge-review / merge-amend logic, operating across the two slots' PRs rather than within a single slot.
- The `selectOrchestrationFlags()` function and `parseT3CodeAdapterArgs()` continue to accept `--duo` but translate it into two pair-mode slot assignments.
- Merge phases (vote, debate, execute, review, amend) remain functionally intact and are adapted to reference PRs/worktrees from two separate slots rather than two agents within one slot.
- `config.yaml` orchestration section: `default_mode: duo` continues to work, triggering hierarchical duo.
- `evaluateTransition()` no longer has duo-specific branches for pre-PR phases; all pre-PR transitions use the pair-mode logic.

## Context

### Current architecture

Orchestration state (`src/orchestration/state.ts`) stores `mode: "duo" | "pair"` per slot. The phase state machine (`src/orchestration/phases.ts`) branches on `state.mode` in several places:

- **`agentParticipatesInPhase()`** (line 150-184): In duo mode, both agents participate in all phases. In pair mode, strict role separation applies (coder does work/pr-create, reviewer does gather/review/pushback).
- **`evaluateTransition()`** (line 332-495): Duo-specific branches at plan (line 361: duo skips plan-merge, goes to plan-review), plan-review (line 373-378: no plan-merge loop in duo), review (line 388-394: no verdict-based looping in duo), update-docs (line 398-399: duo falls through to work if no PR), pr-comments (line 409: duo with two PRs triggers merge-vote).
- **`buildSkillContext()`** in `src/orchestration/skills.ts` (line 207-208): In duo plan-review, each agent reviews the other's independent plan rather than the merged plan.

### Skill templates

Templates live in `skills/orchestration/`. Pair mode uses role-prefixed templates (`pair-coder-work.md`, `pair-reviewer-review.md`). Generic templates (`work.md`, `review.md`, `plan.md`, etc.) serve duo mode. The `resolveTemplatePath()` function (skills.ts line 163-187) falls back from pair-role-specific to generic.

### Slot assignment

`maybeFillEmptySlots()` in `src/mag.ts` (line 2185) currently fills one slot per keepalive cycle. It calls `selectOrchestrationFlags()` in `src/adapters/t3code.ts` (line 690) which reads `default_mode` from config and returns either `--duo` or `--pair` flags.

### Merge phases

Merge-vote, merge-debate, merge-execute, merge-review, and merge-amend phases currently operate within a single slot's two agents. The `hasTwoPrs()` check (phases.ts line 267-269) looks at agents within the state. `readMergeVotes()` and `determineWinner()` are in `src/orchestration/merge.ts`. These must be adapted to work across two separate slots.

### Key files

- `src/orchestration/phases.ts` -- phase state machine, transition logic
- `src/orchestration/state.ts` -- OrchestrationState type, mode field
- `src/orchestration/runner.ts` -- orchestration loop, dispatch, verification
- `src/orchestration/skills.ts` -- skill message composition, template resolution
- `src/orchestration/merge.ts` -- merge voting, debate, winner determination
- `src/orchestration/worktrees.ts` -- git worktree creation/cleanup
- `src/adapters/t3code.ts` -- parseT3CodeAdapterArgs, selectOrchestrationFlags
- `src/adapters/tmux-adapter.ts` -- tmux session naming, duo agent port assignment
- `src/mag.ts` -- maybeFillEmptySlots, auto slot assignment
- `src/slots/index.ts` -- slot assign/clear/start/resume CLI
- `skills/orchestration/` -- all skill templates (pair-specific and generic)

## Scope

### In scope

- Removing duo-specific pre-PR code paths from phases.ts, skills.ts, and runner.ts
- Adding cross-slot coordination: a mechanism for two slots working on the same task to discover each other and trigger merge phases after both have PRs
- Modifying `maybeFillEmptySlots()` to reserve two slots for duo tasks
- Adapting merge phases to operate across two slots' peer-sync directories
- Consolidating or removing generic (duo-only) skill templates
- Updating `selectOrchestrationFlags()` to produce two pair-mode assignments

### Out of scope

- Changing the merge-vote/debate/execute/review/amend logic itself (only adapting its inputs)
- Staging fork forwarding for duo mode (already explicitly excluded: "staging is pair-mode only")
- Adding new phases or changing the pair-mode workflow
- Dashboard UI changes beyond reflecting the new slot linkage
- Task `task-6295b54e` (tmux adapter, already completed)

### Dependencies

- Relates to `task-6295b54e` (tmux adapter) -- completed, no blocker
- No blocking dependencies
