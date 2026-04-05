# Require coder agents to read proposal file before implementing

## Goal

Ensure coder agents always read the proposal file (when one exists) before starting work. Currently, the proposal path is only passively mentioned at the end of the task spec, which agents frequently overlook. This causes avoidable review round-trips when agents miss scope details that are only in the proposal.

Add an explicit, conditional "Step 0: read the proposal" instruction to all coder-facing orchestration templates, and fix the round 2+ brief text to stop claiming the proposal was "already read in round 1."

Ref: https://github.com/lukstafi/ludics/issues/139

## Acceptance Criteria

1. The five coder-facing orchestration skill templates (`work.md`, `pair-coder-work.md`, `plan.md`, `pair-coder-plan.md`, `pair-coder-plan-merge.md`) each contain a conditional block that instructs the agent to read the proposal file when `PROPOSAL_PATH` is non-empty.
2. The conditional block appears before the main task instructions (before `{{TASK_SPEC}}` in templates that have it, or near the top otherwise), so it is not buried at the end.
3. When `PROPOSAL_PATH` is empty (no file-based proposal), no extra instruction appears -- the templates behave exactly as before.
4. In `taskSpecBriefText()` (skills.ts), the round 2+ proposal reference no longer says `"(already read in round 1)"`. Instead it says something like `"Re-read if needed: \`<path>\`"` to avoid the false assumption that the agent retained it.
5. Existing conditional syntax (`{{#IF PROPOSAL_PATH}}...{{/IF}}`) is used -- no new template engine features needed.
6. All existing tests pass. No new tests are required (template substitution is already covered by existing `substituteTemplate` tests).

## Context

**Template files** (`skills/orchestration/`):
- `work.md` (line 1-17): Solo work template. `{{TASK_SPEC}}` on line 5, no proposal reference.
- `pair-coder-work.md` (line 1-17): Pair coder work. `{{TASK_SPEC}}` on line 5, no proposal reference.
- `plan.md` (line 1-16): Solo plan. `{{TASK_SPEC}}` on line 7, no proposal reference.
- `pair-coder-plan.md` (line 1-12): Pair coder plan. `{{TASK_SPEC}}` on line 5, no proposal reference.
- `pair-coder-plan-merge.md` (line 1-19): Plan merge. No `{{TASK_SPEC}}`, but should reference proposal for context during merge.

**`taskSpecBriefText()`** (`src/orchestration/skills.ts:91-106`):
- Line 102-103: Constructs `proposalLine` with `"(already read in round 1)"`. This is the text that needs updating.
- Used for `TASK_SPEC` when `state.round > 1` (line 255).

**`buildSkillContext()`** (`src/orchestration/skills.ts:238-257`):
- Line 241-243: Extracts `PROPOSAL_PATH` from task frontmatter. Already available to all templates.
- Line 257: `PROPOSAL_PATH` is in the context record.

**Template engine** (`src/orchestration/skills.ts:313-318`):
- `substituteTemplate()` supports `{{#IF VAR}}...{{/IF}}` conditional blocks. The body renders only when the variable is non-empty.

**Review templates** (for reference pattern):
- `review.md` line 3: `"If a proposal exists, read it for acceptance criteria: \`{{PROPOSAL_PATH}}\`."` -- this is the existing pattern, but review templates use it inline without the conditional wrapper.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### A. Template changes (5 files)

Add the following conditional block to each template, positioned before `{{TASK_SPEC}}` or at the top of the template body:

```
{{#IF PROPOSAL_PATH}}
**Step 0**: Read the proposal file at `{{PROPOSAL_PATH}}` in the project repo before starting. It contains the authoritative acceptance criteria and scope.
{{/IF}}
```

Placement per file:
- **`work.md`**: After line 3 (`Implement the task...`), before `{{TASK_SPEC}}`.
- **`pair-coder-work.md`**: After line 3 (`Implement the task...`), before `{{TASK_SPEC}}`.
- **`plan.md`**: After line 3 (`Produce an implementation plan...`), before the `Task spec:` line.
- **`pair-coder-plan.md`**: After line 3 (`Write an implementation plan...`), before `{{TASK_SPEC}}`.
- **`pair-coder-plan-merge.md`**: After line 1 (`# Pair Plan Merge...`), before `Merge the two independent plans...`. Wording can be adjusted to "Reference the proposal..." since the merge phase is about combining plans, not starting from scratch.

### B. `taskSpecBriefText()` update (1 file)

In `src/orchestration/skills.ts`, change line 103 from:
```ts
? `\nProposal file: \`${proposalRef}\` (already read in round 1)`
```
to:
```ts
? `\nProposal file: \`${proposalRef}\` — re-read if needed for acceptance criteria`
```

## Scope

**In scope:**
- 5 template file edits (conditional proposal-read block)
- 1 TypeScript edit (`taskSpecBriefText` wording)

**Out of scope:**
- Reviewer templates (already reference `PROPOSAL_PATH`)
- Duo mode templates (separate concern)
- Changes to `substituteTemplate` or the template engine
- Reducing TASK_SPEC verbosity for round 2+ (separate task: task-bc93f2af)
