---
name: ludics-draft-proposal-worker
description: Explore codebase and write proposal document for a task
user-invocable: false
context: fork
agent: general-purpose
allowed-tools: Read, Bash, Glob, Grep, Write
---

# Proposal Worker — Codebase Exploration & Document Writing

You are a worker subagent invoked by the `/ludics-draft-proposal` orchestrator.
Your job: explore a project's codebase, assess the task, and write a proposal document.

Follow the conventions in [worker-conventions.md](worker-conventions.md).

<!-- section:arguments -->
## Arguments

`$ARGUMENTS` format: `<task_id> <project_path> <proposals_path> [<context_brief>]`

- `<task_id>`: Task identifier (e.g., `task-042`)
- `<project_path>`: Absolute path to the project's local checkout
- `<proposals_path>`: Absolute path to the proposals directory (pre-resolved by orchestrator)
- `<context_brief>`: Optional free-form context from the orchestrator (see worker-conventions.md § Broader Context)

<!-- section:process -->
## Process

<!-- section:read-task -->
1. **Read task file**:
   Parse `$ARGUMENTS` to extract the task ID (first word), project path (second word), and
   proposals path (third word). Any remaining text after the third word is the context brief.
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```
   Extract: title, project, dependencies, context, any linked GitHub issue,
   acceptance criteria, elaboration content.

<!-- section:resolve-project-path -->
2. **Resolve project path**: Use the project path from `$ARGUMENTS`. If the
   `personal` project, use `$LUDICS_STATE_PATH/..` (the state repository root).

<!-- section:check-preconditions -->
3. **Check preconditions**:
   - If `has_questions` is set in frontmatter, the task has unanswered
     questions from elaboration — report `status: "error"` with "task has
     unanswered questions" and stop.
   - If the task is clearly stale (work already done, or the goal no longer
     applies), report `status: "stale"` and stop.
   - If the task covers several independent concerns (different modules or
     separable features that could merge to main independently), report
     `status: "split-needed"` and stop.

<!-- section:explore-codebase -->
4. **Explore project codebase**:
   - Read relevant source files mentioned in the task elaboration
   - Understand existing patterns, architecture, related code
   - Use code pointers from the Tentative Design section as starting points

<!-- section:proposals-path -->
6. **Use provided proposals path**:
   Create the directory if it doesn't exist:
   ```bash
   mkdir -p "<proposals_path>"
   ```

<!-- section:write-proposal -->
7. **Write proposal** to `<proposals_path>/<feature-name>.md`:

   ```markdown
   # <Title>

   ## Goal
   Why this change is needed. Link to issue if applicable.

   ## Acceptance Criteria
   What success looks like — faithful to the user's intent as expressed in the
   GitHub issue, task context, and resolved questions. Each criterion should be
   verifiable. Do NOT invent requirements beyond what the user stated or implied.

   ### AC verification reachability — find/grep over commit-SHA when the path is outside project git context

   When an AC's named path sits outside `git -C <project_path>`'s introspection
   reach, the AC's primary evidence must use tooling reachable from the project
   worktree (find/grep), not a commit-SHA from the unreachable subtree.

   Why: `git -C <subpath>` walks parents looking for a `.git` directory and
   returns "not a git repository" when none is found, so an AC that demands a
   SHA from that subtree is self-contradicting at verification time.
   Precipitating instance: `gh-ludics-478` round 1 (PR #491) generated such an
   AC against `~/.claude/projects/-*/memory/`; commit `b4f5a92` reconciled it
   by switching to find/grep evidence with optional secondary harness-side SHA.

   Worked example (memory subtree, `~/.claude/projects/-*/memory/` — where
   `-*` is the structural-shape glob; substitute `-<encoded-project>` in
   actual verification commands so the check stays scoped to the current
   project rather than aggregating across every project's memory tree):
   - Pre-state: `find ~/.claude/projects/-<encoded-project>/memory -name '<file>'` → expected hits.
   - Post-state: the same `find` invocation → expected empty.
   - Index update: `grep -F '<slug>' ~/.claude/projects/-<encoded-project>/memory/MEMORY.md`
     → expected no match. Use the project-scoped path (Claude Code encodes
     the project root into the directory slug, e.g. `-Users-lukstafi-ludics`);
     a literal `~/.claude/projects/-*/memory/MEMORY.md` would shell-glob
     across every project's memory index and produce false positives or
     negatives from unrelated projects. The project-local
     `<project>/memory/MEMORY.md` does not exist either, so do not use it.
   - Optional secondary evidence: the harness-side keepalive-commit SHA, only
     if the harness sync has run; not load-bearing. See `CLAUDE.md` /
     `MEMORY.md` for the harness-side tracking detail — do not inline that
     mechanism here.

   The same rule applies to other paths outside the project's git context:
   cache dirs, generated artefacts, and parent-symlinked trees (where the
   symlink target's git context is unreachable from the symlink path) follow
   the same pattern. Add future instances as new bullets under this
   subsection rather than spawning new subsections.

   ## Context
   How things work now. Key files and code pointers by function/type/symbol
   name — not line numbers, which drift as other PRs merge before implementation.
   When line-level precision is needed, quote a short distinctive code snippet.

   ## Approach (optional)
   Include ONLY when:
   - The approach is straightforward (obvious from context), OR
   - The approach was iterated on with the user (noted in task questions/notes)

   Omit when the approach is a creative choice — the task should be marked for
   duo-mode to let two independent implementations compete.

   Mark as tentative: "*Suggested approach — agents may deviate if they find
   a better path.*"

   ## Scope
   What's in/out of scope. Dependencies on other tasks.
   ```

   Stay on goal/what, not how — no implementation plan, no effort estimates,
   no micro-managed steps. Coding agents handle the how during their plan phase.

   When the task's ACs are unusually contract-heavy, consult [`../docs/ac-rigor-reference.md`](../docs/ac-rigor-reference.md) before writing the criteria.

<!-- section:commit-push -->
8. **Commit and push**:
   Strip the `<project_path>/` prefix from `<proposals_path>` to get the repo-relative path.

   The shared `~/<repo-name>` checkout's HEAD is unspecified state — a prior
   slot or session may have left it on a stale orchestration branch. Switch
   to the project's default branch and fast-forward it *before* staging, so
   the proposal commit lands on the branch from which the orchestration
   runner forks per-agent worktrees. Resolve the default-branch name the
   same way `defaultMainBranch` does in `src/orchestration/worktrees.ts`
   (do not hard-code `"main"` — projects on `master`/`trunk` are covered):

   ```bash
   cd <project_path>
   default_branch=$(
     git symbolic-ref --quiet --short refs/remotes/origin/HEAD \
       | sed 's|^origin/||'
   )
   default_branch=${default_branch:-main}
   git checkout "$default_branch"      # fail-loud: stop on uncommitted changes / detached HEAD
   git pull --ff-only origin "$default_branch"
   git add <proposals_path_relative>/<feature>.md
   git commit -m "proposal: <title>"
   if ! git push origin "$default_branch"; then
     git pull --rebase origin "$default_branch"
     git push origin "$default_branch"   # one retry for concurrent-push race; fail-loud after
   fi
   ```

   **Fail-loud on operator-state corruption.** If `git checkout
   "$default_branch"` cannot succeed (uncommitted changes on the prior
   branch, detached HEAD that cannot be left, etc.), stop and emit
   `status: "error"` with the diagnostic message from git. Do not commit on
   a different branch. Do not stash, reset, or otherwise paper over the
   stale state — the operator's prior checkout state is theirs to recover.

   **Concurrent-push race is handled with one retry, not fail-loud.** A push
   that fails because the remote tip advanced (another slot pushed in the
   same window) is recovered with a single `git pull --rebase origin
   "$default_branch" && git push origin "$default_branch"`. A second
   failure is fail-loud (`status: "error"`).

   The push targets the named branch explicitly (`git push origin
   "$default_branch"`) — do not fall back to a bare `git push` that relies
   on the working tree's prior HEAD or upstream tracking.

<!-- section:update-frontmatter -->
9. **Update task frontmatter**: Set `proposal: <proposals_path_relative>/<feature-name>.md`
   (e.g., `proposal: docs/proposals/add-filter.md`) in the task file.
   Add the field before the closing `---` in the YAML frontmatter.

<!-- section:final-response -->
## Final Response

Use the structured response format from worker-conventions.md. Emit a fenced JSON block
as the last code block in your response:

<!-- section:response-contract -->
### Response Contract

1. `status` — string, required. Values: `"completed"`, `"stale"`, `"split-needed"`, `"already-exists"`, `"error"`.
2. `task_id` — string, required.
3. `proposal_path` — string, conditional. Present only when `status = "completed"` or `"already-exists"`.
4. `ambiguities` — string[], required. `"none"` when empty.
5. `start_confidence` — string, conditional. Present only when `status = "completed"`. Values: `"high"`, `"low"`.
6. `start_rationale` — string, conditional. Present only when `status = "completed"`.
7. `title` — string, required.
8. `summary` — string, required.
9. `skip_plan` — boolean, optional. Present only when `status = "completed"`.
   Set to `true` when the proposal is exhaustive and unambiguous — covers all
   acceptance criteria, specifies exact files/functions, and leaves no design
   choices for the coder. When true, the orchestrator writes `skip_plan: true`
   to task frontmatter so the plan phase is skipped.

```json
{
  "status": "completed | stale | split-needed | already-exists | error",
  "task_id": "<task-id>",
  "proposal_path": "<relative path, e.g. docs/proposals/feature.md>",
  "ambiguities": ["<ambiguity 1>", "<ambiguity 2>"],
  "start_confidence": "high | low",
  "start_rationale": "<one sentence explaining confidence level>",
  "title": "<task title>",
  "summary": "<one-line summary of what was proposed>",
  "skip_plan": false
}
```

Picking `start_confidence`:
- `high` — a clear, bounded improvement with specific scope, derived from a
  concrete user request, a well-defined GitHub issue, or a clearly actionable
  elaboration.
- `low` — exploratory or speculative ("consider", "study", "look into"), with
  unresolved ambiguities that change the scope, or an elaboration that sounds
  suspiciously confident for a vague task.
- Vague acceptance criteria alone don't warrant `low` — follow-up work can
  refine them.
- This is advisory; the orchestrator makes the final decision.

Picking `skip_plan`:
- `true` — the proposal maps 1:1 to implementation and *is* the plan. Typically
  ≤5 files, straightforward changes with exact code pointers, no creative
  design, no architectural decisions.
- `false` (default) — the task benefits from independent planning by coder
  and reviewer.
- `skip_plan` and `start_confidence` are independent: a proposal can be high
  confidence but complex to implement (`skip_plan=false`), or trivial to
  implement with uncertain scope (`skip_plan=true, start_confidence=low`).

<!-- section:error-handling -->
## Error Handling

- Task not found: report `status: "error"` with an explanation.
- Project path not found: report `status: "error"`.
- Already has a proposal: report `status: "already-exists"` with the existing path.
- Git push fails: log a warning and carry on — the proposal is still on disk.
