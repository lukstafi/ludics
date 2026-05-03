# Mutation evidence as standard AC verification

## Goal

Promote the ~30-second mutation-evidence probe (invert / stub / remove the
targeted line, rerun the test, watch the cited assertion flip PASS to FAIL)
from per-PR rediscovery to a canonical reference shape that every coder
template reaches via cross-link. Six retrospectives in a single day
(gh-ludics-405, -407, -438, task-bad0f605, task-f6f80ed5, task-a804cb4d)
independently rediscovered the same probe; closing the gap means landing
the canonical form in `docs/orchestration-patterns.md` so the template
layer doesn't have to re-explain it.

This is the next layer of the same enforceable-AC discipline that #404
(negative-path harness — closed), #434 (pre-assertion harness probe —
closed), #408, and #422 already laid down. Per the user's
`feedback_reference_layer_not_inline` stance, the mechanical shapes land
in the reference doc; the coder template stays unbloated.

Source: https://github.com/lukstafi/ludics/issues/478

## Acceptance Criteria

### Reference doc — primary landing site

- [ ] `docs/orchestration-patterns.md` contains a new sibling subsection
      under the existing **Coding** group titled exactly
      `### Mutation evidence` (a sibling of `### Harness instantiation`,
      `### Negative-case regression testing`, `### Pre-assertion harness probe`).
      Falsifier: `grep -F '### Mutation evidence' docs/orchestration-patterns.md`
      returns one match.
- [ ] The new entry's body contains the literal string
      `flip from PASS to FAIL` (the canonical verification phrasing the
      issue calls out). Falsifier:
      `grep -F 'flip from PASS to FAIL' docs/orchestration-patterns.md`
      returns at least one match inside the new entry.
- [ ] The new entry enumerates all three canonical mutation shapes by
      literal token. Each of the following greps returns at least one
      match in `docs/orchestration-patterns.md`:
  - `grep -F 'sed -i' docs/orchestration-patterns.md` (one-liner mutation)
  - `grep -F 'Edit tool' docs/orchestration-patterns.md` (typed-code mutation)
  - `grep -F 'git stash' docs/orchestration-patterns.md` (guard-removal mutation)
- [ ] The new entry covers the **already-broken-on-base** edge case
      (regression test failing on the base branch as the bug it was
      meant to catch). Falsifier:
      `grep -F 'already-broken-on-base' docs/orchestration-patterns.md`
      returns at least one match.
- [ ] The new entry covers the **multi-assertion AC** edge case
      (one mutation per cited assertion, not one per AC). Falsifier:
      `grep -F 'one mutation per cited assertion' docs/orchestration-patterns.md`
      returns at least one match (alternative literal acceptable if it
      contains both `mutation` and `cited assertion` on the same line —
      reviewer chooses the wording, the structural property is "one-per-
      assertion is named").
- [ ] The new entry includes a **doc/config-AC carve-out** clause
      stating that mutation evidence is required for **test-shaped** AC
      verification lines and **optional but encouraged** for
      doc/config/lint ACs whose verification is a structural property.
      Falsifiers:
  - `grep -F 'test-shaped' docs/orchestration-patterns.md` returns at
    least one match inside the new entry.
  - `grep -F 'optional but encouraged' docs/orchestration-patterns.md`
    returns at least one match inside the new entry.
- [ ] The new entry cross-links to
      `ac-rigor-reference.md#vacuous-docconfig-harness--same-rule-doc-artifacts`
      (the existing Vacuous doc/config harness clause; the actual GitHub-
      rendered slug — `/` is dropped from `doc/config` and the em-dash
      collapses surrounding spaces into `--`). Falsifier:
      `grep -F 'vacuous-docconfig-harness' docs/orchestration-patterns.md`
      returns at least one match.
- [ ] The existing `### Harness instantiation` entry retains its
      `See also` line and that line names the new entry. Falsifier:
      `grep -F 'mutation-evidence' docs/orchestration-patterns.md`
      returns at least two matches (one in the Harness instantiation
      `See also`, one as the new entry's anchor target from elsewhere).

### Reviewer template hint

- [ ] `skills/orchestration/pair-reviewer-review.md` § Acceptance criteria
      verification carries a parallel reviewer-prompt sentence
      immediately after the existing
      `what harness condition would I have to remove for this test to fail?`
      question, asking *what local edit would flip the cited assertion?*
      Falsifier: `grep -F 'what local edit would flip' skills/orchestration/pair-reviewer-review.md`
      returns at least one match.
- [ ] The new reviewer sentence cross-links to the new
      `### Mutation evidence` entry. Falsifier:
      `grep -F 'mutation-evidence' skills/orchestration/pair-reviewer-review.md`
      returns at least one match.

### Coder template touch — minimal

- [ ] `skills/orchestration/pair-coder-work.md` carries **at most one
      added cross-reference sentence** in the existing AC Verification
      paragraph, naming "mutation evidence" and linking to the new
      `### Mutation evidence` anchor. **No new layered checklist, no
      per-line requirement inline.** Falsifiers:
  - `grep -F 'mutation evidence' skills/orchestration/pair-coder-work.md`
    returns at least one match (lower-case `mutation evidence`, the same
    spelling the issue body uses).
  - `grep -F 'mutation-evidence' skills/orchestration/pair-coder-work.md`
    returns at least one match (the anchor link).
  - The added text is one sentence: `git diff` against the current
    template shows the AC Verification paragraph grew by ≤ 1 sentence
    (≤ 200 added bytes excluding the link target). Reviewer verifies by
    eye on the diff; no automated bound.
- [ ] `skills/orchestration/solo-work.md` carries the same minimal
      treatment — one added cross-reference sentence (or no edit if the
      existing paragraph already chains to `### Harness instantiation`,
      whose `See also` now reaches the new entry). Falsifier:
      `grep -F 'mutation' skills/orchestration/solo-work.md` returns at
      least one match (covers both the inline-sentence shape and the
      no-edit-but-See-also-chains shape — the latter still produces a
      match via the unchanged `harness instantiation` link traversal,
      so reviewer chooses one).
- [ ] `skills/worker-conventions.md` § AC verification rigor catalogue
      gains at most a one-line addition naming the mutation-evidence
      family with a link to the new entry. **No new family, no
      restructuring of the existing three-family list** — the addition
      slots into the existing Vacuous-harness family bullet *or* lands
      as a one-line tail bullet. Falsifier:
      `grep -F 'mutation evidence' skills/worker-conventions.md`
      returns at least one match.

### Per-coder memory deprecation (cross-cutting — outside this repo)

This AC applies to coder memory trees under
`~/.claude/projects/-Users-lukstafi-<project>/memory/` — outside the
ludics repo and outside the harness state repo. CI in *this* project
cannot verify it; the verification happens at the time the change lands
and is recorded in the PR description.

- [ ] Delete `feedback_mutation_test_before_done.md` from each coder's
      `~/.claude/projects/-Users-lukstafi-<project>/memory/` tree where
      it currently exists. Today (2026-05-03) the file exists in exactly
      one tree:
      `/Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory/feedback_mutation_test_before_done.md`.
      Verification path: the PR description records the `find` command
      transcript before the change
      (`find ~/.claude/projects -name 'feedback_mutation_test_before_done.md'`)
      and the same command after; the post-change transcript must be
      empty. The reviewer reproduces the post-change `find` independently.
- [ ] Update each affected `MEMORY.md` index to remove the corresponding
      `[…](feedback_mutation_test_before_done.md)` line. Falsifier
      (per affected tree, recorded in PR description):
      `grep -F 'feedback_mutation_test_before_done' ~/.claude/projects/-Users-lukstafi-<project>/memory/MEMORY.md`
      returns no matches after the change.
- [ ] Provenance evidence is recorded in the PR description so the
      reviewer can verify the change without re-deriving it. Two
      acceptable shapes — pick whichever matches the actual tree state
      and prefer reproducible reality over a phantom artifact:
  - **Git-tracked tree** — if the affected memory tree is under a git
    repository (verify with `git -C <memory-dir> rev-parse --show-toplevel`
    succeeding), the PR description names the commit SHA(s) for the
    deletion + index update.
  - **Untracked tree (current state on this machine, 2026-05-03)** —
    the canonical Mag memory tree at
    `/Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory/`
    is **not** under any git repository (`git -C … rev-parse
    --show-toplevel` returns `fatal: not a git repository`, no `.git`
    in the parent chain through `~/.claude`). For untracked trees the
    PR description carries the reproducible post-change evidence
    instead: pre/post `find ~/.claude/projects -maxdepth 3 -name
    'feedback_mutation_test_before_done.md'` transcripts plus the
    post-change `grep -F 'feedback_mutation_test_before_done'
    /Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory/MEMORY.md`
    (no matches). The reviewer reproduces both checks independently.

  Do not fabricate a commit SHA for an untracked tree. If a tree
  becomes git-tracked later (e.g. via the keepalive checkpoint), the
  git-tracked shape becomes the preferred verification.

### No code changes

- [ ] The change set is purely docs / templates / coder-memory. Falsifier
      against this project's diff:
      `git diff --name-only main...HEAD -- src/ test/ scripts/ bin/ examples/`
      returns no entries. The diff touches only
      `docs/orchestration-patterns.md`, the three orchestration skills,
      `skills/worker-conventions.md`, and the coder-memory tree (out of
      this repo's scope).

## Context

### Existing structure in `docs/orchestration-patterns.md`

The **Coding** group (around line 320–520) groups closely related AC-
discipline entries:

- `### AC self-check` (invariant-vs-capability phrasing rule, the
  *line-level* falsifier).
- `### Harness instantiation` (the *test-setup* falsifier — the AC's
  case must actually be produced by the harness; closes loop on
  AC self-check). Worked example walks task-91667552 (stale-base
  warning's vacuous-fetch harness).
- `### Negative-case regression testing` (the *dynamic* version of
  harness instantiation — deliberately break the behaviour, watch the
  test fail, revert).
- `### Pre-assertion harness probe` (the *plan-time* version — enumerate
  the world before drafting the assertion).

Mutation evidence sits naturally as a sibling subsection: it's the
*evidence-citation* shape of the discipline, complementary to harness
instantiation (the *setup* shape) and negative-case regression testing
(the *dynamic verification* shape). The user's slight lean (Q2) was
toward extending the existing `### Harness instantiation` entry, with
explicit permission to split. The existing entry is already 24 lines and
covers two AC shapes, falsifier framing, the invariant/capability
distinction, a worked example, and a boundary clause; adding three
mutation shapes plus three edge cases would push it past the
readability threshold the issue body explicitly calls out for the
coder template. A sibling `### Mutation evidence` entry is the
cleaner shape, and produces a more natural cross-link target for the
reviewer template hint.

### Existing reach of the cross-reference layer

- `pair-coder-work.md` AC Verification paragraph already ends with
  `See [AC self-check](.../#ac-self-check) and [harness instantiation](.../#harness-instantiation).`
  Adding a sibling `Mutation evidence` link is a one-token append to
  that `See also`-equivalent close, or a single new sentence
  immediately before it (proposal phase keeps both shapes acceptable).
- `pair-reviewer-review.md` Acceptance criteria verification paragraph
  already contains `See [harness instantiation](...).` Adding a parallel
  one-sentence reviewer-prompt right after the existing
  `what harness condition would I have to remove for this test to fail?`
  question matches the issue body's symmetry argument.
- `solo-work.md` is shorter (one paragraph, one `See also` link to
  harness instantiation). The Q2 stance lets the new entry land via
  the existing link traversal (no inline edit) or via a one-sentence
  addition; reviewer picks based on local readability.

### `worker-conventions.md` § AC verification rigor catalogue

Currently lists three families (Vacuous-harness, Falsifier-shape,
Process-around-the-AC). The mutation-evidence shape extends the
Vacuous-harness family — a vacuous AC is exactly one whose assertion
needs no mutation companion to flip. The Q1 stance ("trust agents,
reference-layer-not-inline") rules out a new family heading; the
addition should be a one-line tail bullet under the existing
Vacuous-harness family entry, naming "mutation evidence" with a link
to the new doc anchor.

### `ac-rigor-reference.md` § Vacuous doc/config harness clause

The doc/config-AC carve-out (Q3) needs to cross-link this clause —
which already names the rule that doc/config ACs are satisfied by a
structural-property check whose `false` outcome is reachable by
violating the AC. The mutation-evidence carve-out is the same rule
viewed from the other side: when the structural-property check is the
falsifier, mutation evidence on top is redundant; when there is no
structural-property check (test-shaped AC), mutation evidence is what
prevents the vacuous-harness failure mode.

### Per-coder memory file location

Per `feedback_coder_memory_location.md` in Mag's memory, coder memory
trees live at
`~/.claude/projects/-Users-lukstafi-<project>/memory/`, keyed on the
coder's working directory (canonical-path). As of 2026-05-03 the
target file `feedback_mutation_test_before_done.md` exists in exactly
one tree:
`/Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory/`.
That tree's `MEMORY.md` index will need its corresponding line removed.

## Approach (suggested — agents may deviate)

*Suggested approach — agents may deviate if they find a better path.*

1. **Open `docs/orchestration-patterns.md`.** Add a new
   `### Mutation evidence` subsection between
   `### Harness instantiation` and `### Bail-out contract` (i.e.
   immediately after the existing harness-instantiation `See also`
   line). Structure:
   - **Principle.** One-line statement: every test-shaped AC
     verification line cites a one-line mutation-evidence sub-bullet
     showing the assertion flips PASS to FAIL when the targeted code is
     stubbed / inverted / removed.
   - **Why.** Closes the loop: harness instantiation says the *setup*
     produces the case; mutation evidence says the *implementation*
     line under test is the one the assertion actually depends on.
     Without it, an assertion can pass for the wrong reason (an
     invariant elsewhere, a fixture coincidence).
   - **Three canonical shapes** (the issue body's enumeration):
     - `sed -i 's/<old>/<broken>/' <file>` for one-liner mutations.
     - `Edit` tool against a typed code path (flip a return value, swap
       a comparison operator, stub a function body to `throw`).
     - `git stash push -- <file>` for guard removal (revert the
       production change while leaving the new test in place — same
       technique as the existing baseline-aware-framing
       stash-and-rerun, applied to mutation rather than baseline).
   - **Edge case: already-broken-on-base.** When the regression test
     fails on base as the bug it was meant to catch, the mutation
     phrasing changes: assertion *passes* after the fix and *would
     still fail* with the fix reverted, not "flips PASS to FAIL"
     (which presumes a green baseline).
   - **Edge case: multi-assertion AC.** One mutation per cited
     assertion, not one per AC.
   - **Doc/config carve-out.** Mutation evidence is required for
     test-shaped AC verification lines; for doc / config / lint ACs
     whose verification is a structural property (resolvable anchor,
     consumer presence, literal grep), the structural-property check
     itself is the falsifier and mutation evidence is **optional but
     encouraged**. Cross-link to
     `ac-rigor-reference.md` § Vacuous doc/config harness clause.
   - **See also.** Cross-link to `### Harness instantiation` (the
     setup-side companion), `### Negative-case regression testing` (the
     dynamic-verification companion), `### Pre-assertion harness
     probe` (the plan-time companion).
2. **Append `, [mutation-evidence](#mutation-evidence)`** to the
   existing `See also` line at the end of `### Harness instantiation`.
3. **`pair-reviewer-review.md`:** Insert one parallel sentence after
   the existing `what harness condition would I have to remove for this
   test to fail?` question:
   *"And: if no mutation is cited, ask — what local edit would flip the
   cited assertion? See [mutation evidence](.../#mutation-evidence)."*
4. **`pair-coder-work.md`:** Append one cross-reference token to the
   existing `See [AC self-check](...) and [harness instantiation](...)`
   close: `, [mutation evidence](.../#mutation-evidence)`. No layered
   checklist, no per-line requirement inline. Diff bound: ≤ 200 bytes.
5. **`solo-work.md`:** Either (a) leave unchanged (the `See [harness
   instantiation](...)` link now reaches the new entry via that
   subsection's own `See also`), or (b) append the same minimal
   `, [mutation evidence](.../#mutation-evidence)` token. Reviewer's
   call.
6. **`worker-conventions.md` § AC verification rigor:** Append one
   bullet to the existing Vacuous-harness family list:
   `Mutation evidence — for test-shaped AC verification, cite a one-line edit (sed/Edit/stash) that flips the assertion PASS→FAIL.`
   with a link to the new doc anchor.
7. **Per-coder memory deprecation (separate commit, separate repo):**
   - Capture `find ~/.claude/projects -name 'feedback_mutation_test_before_done.md'`
     transcript pre-deletion.
   - Delete the file from
     `/Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory/`.
   - Edit `/Users/lukstafi/.claude/projects/-Users-lukstafi-ludics/memory/MEMORY.md`
     to remove the corresponding index line.
   - Commit in that tree with a referencing message.
   - Capture the post-deletion `find` transcript (must be empty).
   - Paste both transcripts and the commit SHA into the PR description.

## Scope

**In scope:**
- New `### Mutation evidence` entry in
  `docs/orchestration-patterns.md`, structured as enumerated above.
- One-token / one-sentence cross-reference additions to
  `pair-coder-work.md`, `pair-reviewer-review.md`, `solo-work.md`,
  `skills/worker-conventions.md`.
- Deletion of `feedback_mutation_test_before_done.md` (and its
  `MEMORY.md` index line) in each affected coder memory tree —
  **outside this repo**, verified via PR description transcripts.

**Out of scope:**
- Restructuring the existing AC Verification paragraph in
  `pair-coder-work.md` (the user explicitly ruled out a fourth inline
  layer per Q1).
- Any new family heading in `worker-conventions.md` § AC verification
  rigor.
- Source code, CLI, or test changes (other than the structural doc-test
  if the coder chooses to add one — not required by these ACs).
- Ludics-framework runtime changes.

**Dependencies:**
- None — the four predecessor issues (#404, #434, #408, #422) are all
  closed and their template-level changes are already in place. This
  proposal lands on top of that established structure.

**Cross-cutting AC (memory deletion):** The per-coder memory deletion
AC lands in coder memory trees under
`~/.claude/projects/-Users-lukstafi-<project>/memory/`. Those trees
are git-tracked but live outside this repo and outside the harness
state repo, so this project's CI cannot enforce the deletion. The PR
description carries the verification (pre/post `find` transcripts plus
the relevant commit SHAs); the reviewer reproduces the post-state
`find` independently. This shape matches the existing convention for
cross-repo coordination tasks (see e.g. the keepalive-checkpoint
synchronization pattern in Mag's memory).
