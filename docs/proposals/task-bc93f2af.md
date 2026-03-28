# Proposal: Round-aware TASK_SPEC

**Task**: task-bc93f2af
**Effort**: Small
**Status**: Ready to implement

---

## Summary

Make `TASK_SPEC` context-window-aware by sending full task file content only on round 1 and a brief reference (task ID + title + proposal path) on round 2+. This reduces token waste for multi-round sessions where the agent already has full context from the initial prompt.

---

## Motivation

A coder hit 100% context (200k tokens) during a multi-round session, partly because the full task file (frontmatter + acceptance criteria + implementation plan + proposal summary) was re-injected via `{{TASK_SPEC}}` on every phase dispatch. On round 2+, the agent already has this context from round 1 -- re-sending it is pure waste.

---

## Current State

- `taskSpecText(state)` in `src/orchestration/skills.ts` (line 89) reads the full task file, appends proposal pointer + summary and optionally GitHub issue body.
- `buildSkillContext()` (line 235) sets `TASK_SPEC: taskSpecText(state)` unconditionally.
- `PROPOSAL_PATH` was recently added (line 222) and is available in templates.
- `state.round` (number) is available -- round 1 is the first pass, round 2+ means the agent has already seen full context.
- 9 orchestration templates use `{{TASK_SPEC}}`: gather, clarify, pushback, plan (3 variants), work (2 variants), pair-reviewer-gather.

---

## Proposed Changes

### 1. Add `taskSpecBriefText()` function

New function in `src/orchestration/skills.ts` that returns a minimal reference:

```typescript
function taskSpecBriefText(state: OrchestrationState): string {
  const taskId = state.taskId?.trim();
  if (!taskId) return state.slotTitle?.trim() || state.feature;
  const title = state.slotTitle?.trim() || state.feature;
  const path = join(harnessDir(), "tasks", `${taskId}.md`);
  const content = readFileIfExists(path);
  const m = content?.match(/^proposal:\s*(.+)$/m);
  const raw = m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const proposalRef = raw && raw !== "inline" && raw.toLowerCase() !== "null" ? raw : "";
  const proposalLine = proposalRef
    ? `\nProposal file: \`${proposalRef}\` (already provided in round 1)`
    : "";
  return `**Task** ${taskId}: ${title}${proposalLine}\n(Full task spec was provided in round 1 — refer to earlier context.)`;
}
```

### 2. Make `TASK_SPEC` round-conditional in `buildSkillContext()`

Change line 235 from:

```typescript
TASK_SPEC: taskSpecText(state),
```

to:

```typescript
TASK_SPEC: state.round <= 1 ? taskSpecText(state) : taskSpecBriefText(state),
TASK_SPEC_BRIEF: taskSpecBriefText(state),
```

- Round 1: `TASK_SPEC` contains full content (current behavior, unchanged).
- Round 2+: `TASK_SPEC` contains brief reference with task ID, title, proposal path pointer, and a note to refer to earlier context.
- `TASK_SPEC_BRIEF` is always the brief form, available for future explicit use.

### 3. No template changes needed

All 9 templates keep using `{{TASK_SPEC}}` unchanged. The conditional logic is internal to `buildSkillContext()`.

### 4. Add tests in `src/orchestration/skills.test.ts`

- Round 1 (`state.round = 1`): `TASK_SPEC` contains full task file content (existing behavior preserved).
- Round 2+ (`state.round = 2`): `TASK_SPEC` contains brief reference with task ID and title, does NOT contain full file content.
- `TASK_SPEC_BRIEF` always contains the brief form regardless of round.

---

## Scope and Risk

- **Backward-compatible**: Round 1 behavior is identical to current behavior. Only round 2+ changes.
- **No template edits**: All logic is in `buildSkillContext()`.
- **Edge case -- lost context**: If an agent starts a fresh conversation on round 2+, it won't have the full spec. Mitigation: the brief text includes the task ID and proposal path, so the agent can read those files directly. This is acceptable since agents routinely read files from their task scope.
- **Edge case -- phases that only run on round 1**: `gather`, `clarify`, `plan`, `pushback` typically only run on round 1 by design, so they are unaffected. The optimization primarily targets `work` and `review` on rounds 2+.
- **Token savings estimate**: A typical task file with proposal summary is 1500-3000 tokens. The brief form is ~50 tokens. For a 3-round session with 2 agents, this saves ~6000-12000 tokens per session.

---

## Verification

1. Run existing test suite: `bun test src/orchestration/skills.test.ts`
2. Add new tests for round-conditional behavior
3. Manual test: run a multi-round pair session, confirm round 1 gets full spec, round 2 gets brief spec
