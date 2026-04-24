# Reviewer-side phantom-diff diagnosis for stale branches

## Goal

Equip reviewers to recognize phantom deletions caused by a stale worktree base
instead of flagging them as scope violations. This is the reviewer-side
diagnosis layer — complementary to task-91667552's runner-side prevention
layer (stale-base detection at plan-entry).

Source: <https://github.com/lukstafi/ludics/issues/374>.

Motivating incident (gh-ludics-310 coder retrospective, 2026-04-23):
reviewer's round-0 REQUEST_CHANGES flagged three apparent scope problems
grounded in a `git diff main..HEAD --stat` that showed 3765 lines deleted.
The per-commit diff (`git diff <sha>^..<sha> --stat` on the task's actual
commits) showed only four files, 31+/2− total. The "deletions" were commits
that landed on `main` during the task while the worktree's base never moved
forward. The right remediation was `git rebase origin/main`, not manual
restoration.

## Acceptance Criteria

1. **`docs/orchestration-patterns.md` — Scope declaration and salvage entry
   extended.** The existing "Scope declaration and salvage" entry under
   `## Planning` gains a `**Procedure (diff commands).**` sub-bullet that
   explains the difference between `git diff main..HEAD --stat` (cumulative,
   conflates main-side drift with branch changes on stale forks) and
   `git diff <commit>^..<commit> --stat` / `git log main..HEAD --stat`
   (per-commit, attributes changes to the branch's own commits). The
   sub-bullet names the phantom-deletion failure mode and gives the
   reviewer a recipe for distinguishing scope violations from main-side
   drift. A cross-reference to task-91667552's runner-side warning is
   present (as a comment or noted follow-up if that task has not yet landed).

2. **Reviewer plan-review template directive.**
   `skills/orchestration/pair-reviewer-plan-review.md` scope bullet (current
   line 14, the `{{#IF PROPOSAL_PATH}}` block referencing scope declarations)
   contains an explicit diff-command prescription. The command is spelled
   out literally — not only linked through the patterns doc — because the
   cost of misdiagnosis is high and the command is short. The existing
   patterns-doc link is retained.

3. **Reviewer work-review template directive.**
   `skills/orchestration/pair-reviewer-review.md` scope block (current lines
   25–31, the `{{#IF PROPOSAL_PATH}}` scope-review section) contains the
   same explicit diff-command prescription. Wording consistent with the
   plan-review template.

4. **`ludics orch diff <slot>` CLI subcommand.** A new subcommand is added
   to the `orch` dispatch in `src/orchestration/index.ts`. It reads
   orchestration state for the slot, locates each agent's `worktreePath`,
   and emits — per agent worktree — the branch's per-commit summary so
   a reviewer can see the real changeset without running git themselves.
   The default output shape is `git log <default-branch>..HEAD --stat`
   executed inside the worktree. The default branch is resolved via
   `detectDefaultBranches` (preferring `origin`) with `main` as a final
   fallback. Output is plain text to stdout, matching the unadorned style
   of `ludics orch status`.

5. **CLI error handling.** `ludics orch diff` handles the following gracefully
   (non-zero exit with a human-readable message on stderr; no stack traces):
   (a) slot number missing or malformed; (b) no orchestration state for
   the slot; (c) worktree path missing on disk; (d) worktree is not a git
   repository; (e) git invocation fails. Individual agent errors do not
   abort output for other agents in the same slot.

6. **Help text.** The subcommand appears in `README.md`'s CLI reference
   wherever the other `orch` subcommands are enumerated, so CI drift
   detection stays happy and users can discover the command.

7. **Regression tests.**
   - Markdown content checks that the three documentation / skill files
     contain the explicit diff-command guidance (grep-style assertions on
     distinctive substrings, not full-text snapshots).
   - A CLI test that sets up a temporary git repository with a known commit
     history and a minimal orchestration state pointing at it, invokes
     the `orch diff` path, and asserts the output contains the expected
     commit summary. The at-least-one missing-worktree error case is also
     exercised.

## Context

### Current template wording (verified against HEAD)

**`skills/orchestration/pair-reviewer-plan-review.md`** — the scope bullet
inside the `{{#IF PROPOSAL_PATH}}` block currently reads, in substance,
"are all out-of-scope files in the merged plan accompanied by a one-line
scope-expansion justification?" and links to the patterns doc. There is no
diff-command prescription.

**`skills/orchestration/pair-reviewer-review.md`** — the `{{#IF PROPOSAL_PATH}}`
scope-review block instructs the reviewer to "cross-reference the coder's
changes against the proposal's `## Scope` section" and to classify
expansions as accept-as-is or reject-and-salvage. No diff command is
prescribed.

### Current patterns-doc entry

`docs/orchestration-patterns.md` — the `### Scope declaration and salvage`
entry lives under `## Planning`. It currently has three paragraphs: the
**Principle**, the **Why**, and a **Reviewer discretion** bullet. The new
sub-bullet (acceptance criterion 1) sits alongside these, keeping the
section self-contained rather than splitting into a second entry under
`## Reviewing`.

### Orchestration CLI dispatch

The `orch` subcommand dispatcher is `runOrchestrationCli` in
`src/orchestration/index.ts`, a plain `switch (sub)` over the first
argument. Current cases: `status`, `confirm`, `interrupt`, `skip`, `log`,
`run-internal`, `on-stop`. Shape to match: `orchStatus` (at the top of
the same file) reads state via `readOrchestrationState(slot)` and prints
plain text to stdout with labelled fields.

The worktree path is available as `AgentConfig.worktreePath` on each entry
of `state.agents`, defined in `src/orchestration/state.ts`.

### Default-branch detection

`src/git-runner.ts` exports `detectDefaultBranches(cwd, runGit)`, which
returns `{ origin: string | null, upstream: string | null }`. The test
suite in `src/git-runner.test.ts` covers the canonical shapes. Prefer
`origin` for `orch diff`; fall back to `main` if origin is null (the
worktree's remote may be upstream-only, or detection may fail — the
graceful degradation is to at least attempt `main..HEAD`).

### Subprocess conventions in this codebase

Existing orchestration code uses `Bun.spawnSync(["git", ...], { cwd, ... })`
for git invocations in tests (`runner.auto-commit.test.ts`,
`runner.test-helpers.ts`). Production git calls route through
`git-runner.ts`'s `RunGit` abstraction. The `orch diff` CLI can either
reuse `defaultRunGit` (for the `detectDefaultBranches` call) and
`Bun.spawnSync` for the streaming `git log` output, or define a small
helper — worker's choice at implementation time.

### Relationship to task-91667552

- **task-91667552** (runner-side, TypeScript in `runner.ts`): stale-base
  detection at plan-entry; warn the coder to rebase before planning.
  Prevention layer.
- **gh-ludics-374** (this task, markdown in `skills/` + `docs/`, plus the
  new CLI): reviewer-side phantom-diff recognition at plan-review and
  review time. Diagnosis layer.

The two tasks are complementary and touch disjoint files. The patterns-doc
sub-bullet should cross-reference the runner warning so a reviewer who is
staring at a suspicious diff knows the warning *should* have fired at
plan-time; if it didn't, the branch may still be stale.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Template directive wording (criteria 2 and 3)

The context brief specifies the directive verbatim: "When in doubt, prefer
`git log main..HEAD --stat` for per-commit summary and
`git diff <commit>^..<commit> --stat` for each merge's actual change.
Deletions visible in `main..HEAD` but absent from per-commit diffs are
main-side drift, not scope violation."

The plan-review template inserts this as an additional sentence in the
existing scope bullet. The work-review template inserts it as a new bullet
inside the scope block. Both retain the patterns-doc link.

### `ludics orch diff <slot>` output shape

Single shape: `git log <default-branch>..HEAD --stat` per agent worktree,
with a one-line header identifying the agent and worktree. Per the context
brief, a `--commit <sha>` variant is optional; the recommendation is to
**not** add it in the first cut: the `git log ... --stat` output already
shows per-commit file lists, which answers the diagnostic question without
another code path. If reviewers later ask for a focused single-commit view,
add `--commit <sha>` as a follow-up.

### Multi-agent output layout

For pair/duo modes with two agents, emit each agent's block sequentially:

```
=== agent: coder (worktree: /path/to/wt) ===
<git log output>

=== agent: reviewer (worktree: /path/to/wt) ===
<git log output>
```

A reviewer typically only cares about one worktree; sequential blocks let
them scan. No JSON output in v1.

### Error handling

Follow the `orch status` pattern: throw with a descriptive message for
preconditions (missing slot arg, no state) — the top-level CLI handler
prints and exits non-zero. For per-agent errors (worktree missing,
not a git repo, git command fails), print the error under that agent's
header and continue to the next agent.

## Scope

**In scope:**

- Patterns-doc sub-bullet extending the existing "Scope declaration and
  salvage" entry.
- Explicit diff-command directive in both reviewer template files.
- New `ludics orch diff <slot>` CLI subcommand (default shape only —
  `git log <default-branch>..HEAD --stat` per worktree).
- README CLI-reference update to include the new subcommand.
- Regression tests: markdown content assertions for the three doc/template
  files, and a CLI test with a temporary git history.

**Out of scope:**

- `ludics orch diff <slot> --commit <sha>` variant. Recommendation is to
  defer; if the worker determines the case for it is stronger than the
  default-shape coverage, they may include it as a small addition, but
  the proposal does not require it.
- JSON / machine-readable output shapes for `orch diff`.
- Extending `ludics orch diff` to summarize across all slots at once.
- Runner-side stale-base detection (task-91667552's territory).
- Any changes to plan-merge logic itself — this is purely about what the
  reviewer sees and is told to run, not about how the plan is computed.
- New patterns-doc entry under `## Reviewing` — per user decision, the
  `## Planning`-section sub-bullet is sufficient for now.

**Dependencies:**

- `task-91667552` (relates_to): the patterns-doc sub-bullet should
  cross-reference its runner warning. If that task has not merged when
  this one does, the cross-reference can be a forward link with a note
  to be finalized when the sibling lands.
