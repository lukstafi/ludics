# Scope declaration and salvage for agent changes

## Goal

When coder agents change files outside the proposal's declared scope, today there is no shared mechanism for the reviewer to accept, reject, or redirect that work — rejection silently discards potentially valuable diffs, and acceptance hides scope drift. This task adds:

1. A **declaration** step on the coder side: intentional scope expansions are flagged in the plan and/or commit, so they are visible at review time.
2. **Reviewer discretion**: the reviewer decides whether an expansion is merged as-is or rejected. Scope violations are no longer a blanket blocker.
3. A **salvage step** on the coder side: when a scope expansion is rejected, the coder extracts the rejected diff into a new `needs-confirmation` follow-up task (same pattern as retrospective-generated suggestions) before reverting the files. Nothing useful is thrown away.

Dead-code cleanups and other "while I'm here" improvements should be carried by parallel tasks, not silently absorbed into the current one. Scope is still meaningful — it shouldn't be exceeded *intentionally without flagging* — but accidental overreach is a normal event that the salvage flow handles gracefully.

Issue: https://github.com/lukstafi/ludics/issues/305

## Acceptance Criteria

1. The coder plan template (`pair-coder-plan.md`) instructs the coder to cross-reference the plan's file list against the proposal's `## Scope` section and, if any out-of-scope files are included, flag them as scope expansions with a short justification in the plan.

2. The coder work template (`pair-coder-work.md`) instructs the coder:
   - If they become aware during implementation that a change touches an out-of-scope file, either (a) declare it as a scope expansion in the commit message (one line: `scope-expansion: <reason>`), or (b) leave it out and note it in the task's `Notes` section as a follow-up candidate.
   - Do **not** silently include out-of-scope changes.
   - "While I'm here" cleanups (dead code, reformatting, adjacent refactors) should normally be deferred to a separate parallel task, not absorbed.

3. The reviewer review template (`pair-reviewer-review.md`) instructs the reviewer:
   - Scope compliance is a review *consideration*, not a hard blocker. The reviewer decides per-expansion whether to accept (merge as-is) or reject (require removal from this PR).
   - When rejecting an out-of-scope change, the reviewer explicitly asks the coder to **salvage** the rejected diff into a needs-confirmation follow-up task rather than discard it.
   - Undeclared out-of-scope changes (no scope-expansion note in commit or plan) are flagged as a discipline issue, even if the reviewer ultimately accepts them.

4. The coder work template documents a salvage procedure invoked when the reviewer rejects a scope expansion:
   - Capture the rejected diff (`git diff -- <paths>` scoped to the rejected files, or a filtered patch).
   - Create a new follow-up task with `status: needs-confirmation`, `relates_to: [<current-task-id>]`, and the captured diff + justification in the task body.
   - Revert the files (`git checkout -- <paths>`) and continue with the in-scope work.
   - The new task goes through the existing needs-confirmation flow (surfaced in briefings, confirmed or dismissed by the user).

5. The plan-review template (`pair-reviewer-plan-review.md`) instructs the reviewer to check that any out-of-scope files in the merged plan are accompanied by a declared scope-expansion justification. Flag missing justifications; do not block solely on scope.

6. All scope-related instructions are conditional on a proposal existing (guarded by `{{#IF PROPOSAL_PATH}}`). Tasks without proposals are unaffected.

## Context

### Current template structure

The orchestration templates in `skills/orchestration/` guide coder and reviewer agents through the plan-work-review cycle. Each template receives `{{PROPOSAL_INSTRUCTION}}` and `{{PROPOSAL_PATH}}` via `buildSkillContext()` in `src/orchestration/skills.ts`. Proposals already include a `## Scope` section (authored per `skills/ludics-draft-proposal-worker.md`), but no downstream template currently references or enforces it.

### Why a softer approach

The original framing of this issue proposed pre-commit scope checks + blocking reviewer rejection. That approach treats well-meaning out-of-scope work as a compliance failure and creates cognitive overhead on every commit. In practice, much of the observed "scope creep" is genuinely useful work (dead code cleanup, drive-by fixes) — the problem is not that agents do it, but that it lands silently and bloats the PR. The salvage flow addresses the real cost (silent drift, wasted good work when rejected) without making scope a policing activity.

### Existing salvage precedent

The retrospective-suggestion flow (`ludics-process-suggestions`) already creates `status: needs-confirmation` follow-up tasks with `relates_to` pointing at the source task. The salvage flow reuses this pattern: same frontmatter shape, same dashboard/briefing surfacing, no new machinery.

### Related tasks

- **gh-ludics-220** (completed): Code-Proposal Alignment Checklist in plan-merge/plan-review — verifies plan matches proposal's technical assumptions. This task complements it by addressing *scope* declarations.
- **gh-ludics-311**: Proposal assumption drift (complementary).
- **gh-ludics-316**: AC verification (complementary, shares the "before signaling done" checkpoint pattern).

### Template insertion points

- **`pair-coder-plan.md`** — scope cross-reference after the file-listing / symbol-grep paragraph.
- **`pair-coder-work.md`** — declaration guidance in the "drift tends to creep in" region + a salvage procedure block guarded by `{{#IF PROPOSAL_PATH}}`.
- **`pair-reviewer-review.md`** — reviewer discretion + salvage-request guidance alongside existing review criteria. Not a blocking item on its own.
- **`pair-reviewer-plan-review.md`** — one bullet in the existing Code-Proposal Alignment section for declared-vs-undeclared out-of-scope files.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Template-only changes to four files. No code changes to `skills.ts` or any TypeScript source. No new template variables. The salvage flow is documented as agent-executed steps (CLI + git) rather than a new orchestrator feature.

### 1. `pair-coder-plan.md` — declare scope expansions in the plan

Add after the existing symbol-grep instruction:

```
{{#IF PROPOSAL_PATH}}
**Scope declaration**: Cross-reference your file list against the `## Scope` section of the proposal at `{{PROPOSAL_PATH}}`. If the plan includes any out-of-scope files, list them explicitly as scope expansions with a one-line justification each. The reviewer will decide per-expansion whether to accept or redirect to a follow-up task.
{{/IF}}
```

### 2. `pair-coder-work.md` — declaration + salvage procedure

Add near the "drift tends to creep in" region (before the AC block):

```
{{#IF PROPOSAL_PATH}}
**Scope discipline**: If you realize a change touches a file outside the proposal's `## Scope`, either:
- **Declare it**: add `scope-expansion: <one-line reason>` to the commit message so the reviewer sees it, OR
- **Defer it**: leave the file alone and jot the idea in the task's `Notes` section (or open a follow-up task directly) — do not silently include it.

"While I'm here" cleanups (dead code, reformatting, adjacent refactors) should normally be deferred to a separate parallel task rather than absorbed here.

**Salvage on rejection**: If the reviewer rejects a declared scope expansion, do not just discard the diff. Run:
- `git diff -- <rejected-paths> > /tmp/salvage-<task-id>.patch` to capture the rejected changes.
- `ludics tasks create "<short description>" <project> C --relates-to <current-task-id>` (or write a task file directly) and paste the captured patch plus justification into the task body. Set `status: needs-confirmation` in the frontmatter so the user confirms or dismisses it via the standard flow.
- `git checkout -- <rejected-paths>` to revert, then continue with the in-scope work.
{{/IF}}
```

### 3. `pair-reviewer-review.md` — discretion + salvage-request guidance

Add a scope paragraph (not a blocking item, placed alongside existing review considerations):

```
{{#IF PROPOSAL_PATH}}
**Scope review (discretion)**: Cross-reference the coder's changes against the proposal's `## Scope` section at `{{PROPOSAL_PATH}}`. Scope expansions are not automatic blockers — decide per-expansion whether the change belongs in this PR or should be salvaged to a follow-up:
- **Accept as-is**: the expansion is small, directly supports the goal, and doesn't broaden the PR's review surface materially.
- **Reject and ask for salvage**: the expansion is valuable but belongs in its own task. In your review comment, explicitly ask the coder to salvage the rejected diff into a needs-confirmation follow-up task (capture patch → revert → new task with `relates_to`) before continuing.

Flag **undeclared** out-of-scope changes (no `scope-expansion:` note in commit, no mention in plan) as a discipline issue, even if you accept the content — the coder should be making scope expansions visible at commit time.
{{/IF}}
```

### 4. `pair-reviewer-plan-review.md` — declared-vs-undeclared bullet

Add one bullet to the existing Code-Proposal Alignment list:

```
- Are all out-of-scope files in the plan accompanied by a declared scope-expansion justification? Flag missing justifications; scope itself is not a blocker, but undeclared expansions are a discipline issue.
```

## Scope

**In scope:**
- `skills/orchestration/pair-coder-plan.md` — scope declaration instruction
- `skills/orchestration/pair-coder-work.md` — declaration guidance + salvage procedure
- `skills/orchestration/pair-reviewer-review.md` — discretion + salvage-request guidance
- `skills/orchestration/pair-reviewer-plan-review.md` — declared-vs-undeclared bullet

**Out of scope:**
- Changes to `src/orchestration/skills.ts` or any TypeScript code (no new template variables, no new CLI flags)
- Automated `git diff --stat` validation in the runner (too heavy, high false-positive risk)
- Extracting `## Scope` as a separate template variable (unnecessary complexity)
- A new `ludics tasks salvage` CLI subcommand (salvage is an agent-executed sequence of existing commands; only add a subcommand if the manual path proves error-prone in practice)
- Changes to the proposal template itself (already instructs `## Scope` inclusion)
- Changes to `pair-reviewer-plan.md`, `pair-reviewer-gather.md`, or other templates outside the scope-declaration / salvage critical path
