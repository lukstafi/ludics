# draft-proposal-worker: AC verification reachability — find/grep over commit-SHA when the path is outside project git context

## Goal

`ludics-draft-proposal-worker.md`'s AC-template guidance has no rule
covering ACs whose named paths sit outside `git -C <project_path>`'s
introspection reach. The precipitating instance was `gh-ludics-478`
round 1 (PR #491): the worker generated an AC demanding a commit SHA
in the coder-memory subtree's git history, but
`git -C /Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory rev-parse --show-toplevel`
returns `fatal: not a git repository`. The subtree IS git-tracked
indirectly via the `harness/claude-memory/` symlink and the keepalive
checkpoint (see `CLAUDE.md` / `MEMORY.md` for the harness-side tracking
detail), but `git -C` against the subtree path can't discover that — it
walks parents, hits `~/.claude`, and returns "not a git repository". The
AC was unsatisfiable as written. The coder reconciled in round 2
(commit `b4f5a92`, "proposal: repair memory-provenance AC sub-bullet for
untracked trees") by switching to find/grep evidence with optional
secondary harness-side SHA.

This proposal promotes the round-2 recovery shape into the worker's
default AC-template guidance, framed as a *verifier-tooling-reach* rule
(per the user's Q4 broadening): the rule fires whenever an AC's named
path is outside `git -C <project_path>`'s introspection reach, not only
for the memory subtree. The memory subtree is the precipitating example;
cache dirs, generated artefacts, and parent-symlinked trees follow the
same pattern as future bullets under the same section.

Sibling task `task-097cca67` (PR #498, merged 2026-05-05) addressed a
related root-cause class — worker AC-template generates ACs that don't
match the verifier's tooling reach — but landed at the reference-doc
layer with an explicit negative control on the worker skill, citing
`feedback_reference_layer_not_inline.md`. This task is distinct: the
user's resolved Q1 explicitly directs landing the new guidance as a
dedicated subsection within the worker skill's AC-template area, not in
the reference doc. The resolved scope (Q1, Q2, Q3, Q4, Q5) governs
placement.

Linked: gh-ludics-478 round 1 self-contradicting AC; commit `b4f5a92`
round-2 repair; `feedback_reference_layer_not_inline.md` (cross-checked,
not contradicted — Q1 picks the worker-skill-body landing site for this
specific case).

## Acceptance Criteria

- [ ] AC1 — `skills/ludics-draft-proposal-worker.md` gains a new
      `### ` subsection inside step 7's `## Acceptance Criteria` block of
      the proposal template (the markdown fenced block beginning around
      the `# <Title>` placeholder), with the title exactly:
      `### AC verification reachability — find/grep over commit-SHA when the path is outside project git context`.
      Falsifier: `grep -F "### AC verification reachability — find/grep over commit-SHA when the path is outside project git context" skills/ludics-draft-proposal-worker.md`
      returns ≥1 hit.
- [ ] AC2 — The new subsection sits inside the proposal-template fenced
      code block (between the opening ` ```markdown ` line and its
      matching ` ``` ` close), under `## Acceptance Criteria`, so it is
      part of the worker-emitted template guidance rather than commentary
      around it. Falsifier:
      `awk '/^   ```markdown/,/^   ```$/' skills/ludics-draft-proposal-worker.md | grep -F "### AC verification reachability"`
      returns ≥1 hit.
- [ ] AC3 — The new subsection states the rule pithily (one or two short
      sentences) followed by a 1–2 sentence rationale and a named cite to
      `gh-ludics-478` round 1 plus commit `b4f5a92`. Falsifier (within
      the new subsection's body — the lines between its `### ` heading
      and the next `### ` or `## ` heading): `grep -F "gh-ludics-478"`
      returns ≥1 hit AND `grep -F "b4f5a92"` returns ≥1 hit.
- [ ] AC4 — The new subsection includes a worked example for the memory
      subtree, naming the find/grep evidence shape concretely:
      pre-deletion `find` over `~/.claude/projects/-*/memory/` (expected
      hits), post-deletion `find` (expected empty), post-change `grep`
      over `MEMORY.md` for the slug (expected no match), and the
      harness-side keepalive-commit SHA listed as OPTIONAL secondary
      evidence (not load-bearing). Falsifier (within the new
      subsection's text range): `grep -E "find|grep"` returns ≥2 hits AND
      `grep -F "MEMORY.md"` returns ≥1 hit AND
      `grep -E "optional|secondary"` returns ≥1 hit.
- [ ] AC5 — The new subsection notes that the rule generalises beyond
      the memory subtree: cache dirs, generated artefacts, and
      parent-symlinked trees are covered by the same pattern, with future
      instances added as new bullets under the same subsection rather
      than spawning new subsections. Falsifier (within the new
      subsection's text range): at least one of `cache`, `generated`, or
      `parent-symlinked` (or `parent symlink`) appears AND the rule's
      generality is stated explicitly (one of `same pattern`, `same
      rule`, `same shape`, or `generalises`).
- [ ] AC6 — The new subsection links by reference, not by inlining the
      symlink architecture: it points at `CLAUDE.md` / `MEMORY.md` for
      the harness-side tracking detail rather than restating the
      `harness/claude-memory/` symlink + keepalive-checkpoint mechanism.
      Falsifier (within the new subsection's text range): `grep -F
      "CLAUDE.md"` returns ≥1 hit AND `grep -F "MEMORY.md"` returns ≥1
      hit AND `grep -F "harness/claude-memory"` returns 0 hits AND
      `grep -F "keepalive checkpoint"` returns 0 hits.
- [ ] AC7 — Skill-template-only change: no source, script, or test files
      are modified. Falsifier:
      `git diff --name-only main...HEAD | grep -E '^(src/|scripts/|.*\.test\.ts$)'`
      returns 0 hits.
- [ ] AC8 — Diff-enumerated scope invariant: the only file changed under
      `skills/` is `skills/ludics-draft-proposal-worker.md`, and the only
      file changed under `docs/proposals/` is this proposal file. No
      `docs/ac-rigor-reference.md` change is in scope (the user's Q1
      placed the rule in the worker skill body, not the reference doc).
      Falsifier:
      `git diff --name-only main...HEAD | grep '^skills/' | grep -v -F 'skills/ludics-draft-proposal-worker.md'`
      returns 0 hits AND
      `git diff --name-only main...HEAD | grep -F 'docs/ac-rigor-reference.md'`
      returns 0 hits.
- [ ] AC9 — Pre-existing AC-template guidance is preserved. The general
      "verifiable … do NOT invent requirements beyond what the user
      stated" prose remains in the `## Acceptance Criteria` block of the
      proposal template, untouched aside from the new subsection
      addition. Falsifier: `grep -F "Each criterion should be" skills/ludics-draft-proposal-worker.md`
      returns ≥1 hit AND `grep -F "Do NOT invent requirements" skills/ludics-draft-proposal-worker.md`
      returns ≥1 hit.

## Context

### Touch site (verified post-pull, 2026-05-10)

- `skills/ludics-draft-proposal-worker.md` — the proposal template lives
  inside step 7 (`<!-- section:write-proposal -->`) as a fenced
  ` ```markdown ` … ` ``` ` block. The block currently contains
  `## Acceptance Criteria` with one paragraph of prose
  ("What success looks like — faithful to the user's intent … Each
  criterion should be verifiable. Do NOT invent requirements beyond what
  the user stated or implied."). The new `### ` subsection is appended
  beneath that paragraph, still inside the fenced block. No other
  modifications.

  The file was recently edited by `b9d7961` (AC verification rigor
  reference doc) and `b483ac4` (skills: add section anchors to 4
  medium-priority skill files); both edits left the AC-template prose
  intact and added structure around it. The new subsection is additive
  in the same shape.

### Pre-proposal grep audit (2026-05-10)

Before drafting, ran:

```bash
grep -n -E "git context|reachab|find.*grep|memory|claude/projects" \
  skills/ludics-draft-proposal-worker.md
```

Result: only matches were `worktrees` references in step 8's git
discipline (post-PR-#519). No existing AC-template guidance overlaps
with the new subsection's scope. Confirms the structural gap and the
clean landing site.

### Sibling reference (verified)

- `task-097cca67` (PR #498, merged 2026-05-05) — same root-cause class
  (worker AC-template generates ACs that don't match the verifier's
  tooling reach) but landed at the reference-doc layer
  (`docs/ac-rigor-reference.md`) with an explicit negative control on
  `skills/ludics-draft-proposal-worker.md`, per
  `feedback_reference_layer_not_inline.md`. This task is distinct: the
  user's resolved Q1 explicitly picked option (b) — dedicated subsection
  in the worker skill body. The resolved scope governs.

### Why find/grep over commit-SHA

`git -C <subpath>` walks parents looking for a `.git` directory. For
the memory subtree at `~/.claude/projects/-*/memory/`, the walk hits
`~/.claude` (no `.git`) and returns "not a git repository". The path IS
git-tracked elsewhere (via the `harness/claude-memory/` symlink and the
keepalive checkpoint commit), but the verifier running from
`<project_path>` has no portable way to discover that without harness
introspection. `find` and `grep` evidence — pre-state hits, post-state
empty, plus a post-change `grep` over `MEMORY.md` for the slug — are
directly verifiable from the project worktree without leaving its
introspection reach. The harness-side keepalive-commit SHA stays
available as OPTIONAL secondary evidence ("if the harness sync has run,
the deletion is also visible at `harness/claude-memory/.../MEMORY.md`")
without becoming load-bearing.

### Generalisation (per resolved Q4)

The rule is framed as a *verifier-tooling-reach* check, not a
memory-specific one. Whenever an AC names a path outside
`git -C <project_path>`'s introspection reach — memory subtree, cache
dirs (e.g., per-tool caches under `~/.cache`), generated artefacts (e.g.,
build outputs that aren't committed), parent-symlinked trees (where the
symlink target's git context is unreachable from the symlink path) —
the AC's primary evidence must use tooling reachable from the project
worktree (find/grep). The memory subtree is the precipitating example
that lands as the worked example; future instances become new bullets
under the same subsection, not new subsections.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Locate the proposal template in step 7 of
   `skills/ludics-draft-proposal-worker.md` (the fenced ` ```markdown `
   block following the `<!-- section:write-proposal -->` anchor). Inside
   that block, find the `## Acceptance Criteria` paragraph.
2. Append the new `### ` subsection directly after the existing AC prose
   paragraph, still inside the fenced block. Subsection title (verbatim,
   per AC1):
   `### AC verification reachability — find/grep over commit-SHA when the path is outside project git context`.
3. Body shape (per Q2 / Q3 / Q4):
   - Opening: pithy rule (one or two short sentences) — when an AC's
     named path is outside `git -C <project_path>`'s introspection
     reach, the AC's primary evidence uses tooling reachable from the
     project worktree (find/grep), not commit-SHA from the unreachable
     subtree.
   - Rationale (1–2 sentences): name the failure mode — `git -C
     <subpath>` walks parents, fails to find `.git`, returns "not a git
     repository"; the AC becomes self-contradicting. Cite
     `gh-ludics-478` round 1 and commit `b4f5a92` round-2 repair.
   - Worked example: memory subtree (`~/.claude/projects/-*/memory/`)
     with the find pre/post + `MEMORY.md` grep evidence shape; note the
     harness-side keepalive-commit SHA as OPTIONAL secondary evidence.
   - Generalisation note: the rule covers cache dirs, generated
     artefacts, and parent-symlinked trees by the same pattern; future
     instances become new bullets under the same subsection.
   - By-reference link: "see `CLAUDE.md` / `MEMORY.md` for the
     harness-side tracking detail" — do not inline the
     `harness/claude-memory/` symlink + keepalive-checkpoint
     architecture.
4. Run AC falsifiers locally before committing (the greps in AC1–AC9
   are self-contained shell commands) to confirm scope and shape.
5. Commit on the default branch per step 8 of the worker skill (already
   updated post-PR-#519 to fail-loud-on-stale-state) — no plan phase
   (skip_plan=true).

## Scope

**In scope.**

- `skills/ludics-draft-proposal-worker.md` — append one new `### `
  subsection inside the proposal template's `## Acceptance Criteria`
  block.
- This proposal file under `docs/proposals/`.

**Out of scope.**

- Any code changes (`src/**`, `scripts/**`, `*.test.ts`) — explicit
  negative control (AC7). Skill-template-only.
- `docs/ac-rigor-reference.md` — the user's resolved Q1 placed this
  rule in the worker skill body, not the reference doc (AC8). The
  reference-doc layer remains the home for sibling-task-097cca67's
  contribution; this task's contribution lands in the worker skill.
- Other skill files under `skills/` — only the draft-proposal-worker is
  modified (AC8).
- Generalising the rule into the orchestrator skill, reviewer skill, or
  agent conventions — out of scope; this task is targeted at the
  proposal-authoring entry point.
- Auditing past proposals for retroactive AC revision — out of scope.
  The rule applies prospectively to future worker invocations.

**Dependencies.** None. `gh-ludics-478` (relates_to) merged 2026-05-03;
`task-097cca67` (relates_to) merged 2026-05-05; PR #519's git-discipline
update to step 8 has already merged into `main`.
