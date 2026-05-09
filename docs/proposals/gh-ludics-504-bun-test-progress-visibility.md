# gh-ludics-504: Note for `bun test` progress visibility during plan/review

## Goal

Issue: https://github.com/lukstafi/ludics/issues/504

Coders following the pair-coder-plan / pair-reviewer-gather skills today reach
for invocations like `bun test 2>&1 | tail -40` when capturing test output to
the harness's per-round output file. The pipe-to-`tail` form buffers stdout
until the upstream process closes, so during a 50+ second run the captured
file stays empty. Coders who watch the file conclude the suite is hung and
plan around a phantom failure mode — round 1 of task-c4e0e80a recorded an
explicit "narrow baseline + full-suite pending" workaround that the reviewer
correctly rejected, costing a second merge round.

The fix is one short canonical note on how to capture progress-visible
`bun test` output, plus cross-links from the two skill paragraphs that today
say only "run `bun test`".

## Acceptance Criteria

1. **Canonical note exists.** A short subsection (one paragraph or a small
   bulleted block, ~5–10 lines) titled along the lines of "Running the test
   suite" lives in either
   `skills/worker-conventions.md` or
   `docs/orchestration-patterns.md`. The chosen home is justified by one
   sentence in the surrounding prose or commit message — both files are
   plausible reference targets and the choice should be deliberate, not
   accidental.

2. **Note recommends file redirection over pipe-to-tail.** The note
   recommends `bun test > /tmp/<name>.out 2>&1` (or the `tee` equivalent,
   `bun test 2>&1 | tee /tmp/<name>.out`) as the load-bearing form for
   capturing output the harness can watch in real time. POSIX-shell
   ordering matters: `> file 2>&1` captures both streams to the file,
   while `2>&1 > file` duplicates stderr to the *original* terminal
   stdout before stdout is redirected and silently drops stderr — so the
   note must use the `> file 2>&1` order, not the reversed form. It
   explicitly calls out that `bun test 2>&1 | tail -40` (or any
   pipe-to-`tail`/`head`/`grep` without `--line-buffered`) buffers stdout
   and leaves the captured file empty until the suite finishes — the
   failure mode this note exists to prevent.

3. **Per-round filename suffix is suggested.** The note suggests a
   per-round-distinct filename (e.g. `/tmp/bun-test-baseline.out`,
   `/tmp/bun-test-round-N.out`) so a stale file from an earlier round can't
   be mistaken for current output. One-line mention is sufficient; no
   normative mandate.

4. **Worktree fallback is mentioned.** The note mentions
   `.peer-sync/bun-test-baseline.out` (or a comparable worktree-relative
   path) as an alternative when `/tmp` is unavailable or undesirable. One
   short clause is sufficient.

5. **Both skill paragraphs cross-link to the note.** The `bun test`
   paragraph in
   `skills/orchestration/pair-coder-plan.md` (the line beginning "Before any
   code changes, run `bun test` …") and the `bun test` paragraph in
   `skills/orchestration/pair-reviewer-gather.md` (the line beginning "Run
   `bun test` and record every failing test name …") each link to the new
   note via a short `see [<anchor>](...)` reference, in the same shape
   already used elsewhere (e.g. the `pre-existing-failures-baseline` link
   already on the coder side). Wording around the new link stays in lockstep
   between the two skill files — same anchor, same phrasing for the
   pointer.

6. **No test-suite changes.** This is a doc-only change; `bun test` should
   pass with no new or modified test files. `bun run lint` should also pass
   (no skill-CLI references introduced).

## Context

**Skill files to cross-link from** (prose-only edits, additive):

- `skills/orchestration/pair-coder-plan.md` — the paragraph beginning
  "Before any code changes, run `bun test` …". This is the only place the
  coder skill prescribes a `bun test` invocation. It already links to
  `pre-existing-failures-baseline` in `docs/orchestration-patterns.md`,
  which is the link-shape the new cross-link should mirror.
- `skills/orchestration/pair-reviewer-gather.md` — the paragraph beginning
  "Run `bun test` and record every failing test name …". This is the
  reviewer-side counterpart and the second site that needs the cross-link.

**Reference-doc candidates** (the new note lives in exactly one of these):

- `skills/worker-conventions.md` — currently has no test-running section.
  Existing sections are listed in the file's prose ("Argument Parsing",
  "Scope", "Skill body CLI references", "AC verification rigor",
  "Manual-Smoke Evidence", "Broader Context", "Structured Response Format",
  …). A new short section, e.g. "Running the test suite", is the natural
  home if the note is about *how a worker invokes the suite*.
- `docs/orchestration-patterns.md` § "Pre-existing failures baseline"
  (around line 21) — already the destination both skill paragraphs link to
  for related test-running guidance. A new sibling pattern (or a short
  appendix to the existing baseline section) is the natural home if the
  note is about *the orchestration-level capture pattern*.

Either home is defensible; the implementer chooses one and writes a
sentence justifying the choice in the commit message or surrounding prose.
What matters for follow-up consistency is that the two skill cross-links
point at the *same* anchor.

**Why pipe-to-`tail` buffers and file redirection doesn't.** When stdout is
a regular file, the kernel flushes line-by-line (or close to it) and a
watcher (`tail -f`, harness file read) sees progress. When stdout is a
pipe, the C runtime in the upstream process applies block-buffered stdio
(typically 4–8 KiB) until the process exits or explicitly flushes —
`bun test` does not flush per-line, so 50+ seconds of test output stays in
the buffer until the suite ends, at which point `tail -40` finally drains
the pipe and writes its window to the file. Replacing the pipe with file
redirection (`> /tmp/x.out`) or with `tee` (which writes to a regular file
in addition to the pipe) restores line-by-line visibility because the
*file* end of the duplication is line-buffered. `grep --line-buffered`
addresses the filtering use case but does nothing for the upstream
`bun test` buffer; it is mentioned, if at all, only as a complement.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add the canonical note in `skills/worker-conventions.md` as a new short
   "Running the test suite" section near the existing "AC verification
   rigor" section. (Picking worker-conventions over orchestration-patterns
   on the grounds that the note is about *how a worker invokes the suite
   for capture*, not about the cross-worker baseline pattern that
   orchestration-patterns already covers. The implementer may invert this
   if they read the boundary differently — the AC accepts either home.)
2. Add a `## Running the test suite` heading. Body covers, in order: the
   recommended capture form (`bun test > /tmp/<name>.out 2>&1` or `tee`,
   noting that `2>&1 > file` reverses the redirection chain and drops
   stderr), the failure mode it prevents (pipe-to-`tail` buffering), the
   per-round-suffix suggestion, and the `.peer-sync/` worktree fallback.
3. Update `skills/orchestration/pair-coder-plan.md`: append a short
   `see [running the test suite](../worker-conventions.md#running-the-test-suite)`
   (or the equivalent anchor) to the existing `bun test` paragraph,
   immediately before or after the `pre-existing-failures-baseline` link.
4. Update `skills/orchestration/pair-reviewer-gather.md`: append the same
   cross-link to the existing `bun test` paragraph, with identical
   pointer phrasing.
5. Verify the anchor slug locally (GitHub-style: lowercase, spaces to
   hyphens, no punctuation) before committing.
6. `bun run lint && bun test` to confirm no regressions; both should be
   no-ops for a doc-only change.

## Scope

**In scope:**

- One new short subsection in `skills/worker-conventions.md` *or*
  `docs/orchestration-patterns.md` (implementer's choice — see AC 1).
- Two cross-link additions, one each in
  `skills/orchestration/pair-coder-plan.md` and
  `skills/orchestration/pair-reviewer-gather.md`.

**Out of scope:**

- Any change to `bun test` invocation in CI, scripts, or test files.
- Any new lint rule. The literal `tail -40` does not appear in skill files
  today (it's a coder mental model, not a written prescription), so there
  is no string for `lint:skill-cli-refs` to anchor on. Authoring a new
  lint that pattern-matches free-form prose is a separate, larger task
  (file as a follow-up only if drift recurs after this note lands).
- Other test-running guidance (parallelism, watch mode, focused tests) —
  this note is scoped to the captured-output progress-visibility failure
  mode only.
- Edits to other skills that mention `bun test` in passing
  (`docs/orchestration-patterns.md` itself contains three such mentions,
  but they are about the failure-list baseline pattern, not about capture
  form, and don't need the cross-link).

**Dependencies:** None. No blocking tasks; no follow-ups required by this
proposal.

**Effort:** tiny — one short doc section plus two single-line cross-links.
