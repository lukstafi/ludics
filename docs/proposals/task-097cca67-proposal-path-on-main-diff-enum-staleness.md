# Proposal-path enumeration goes stale when proposal commits to main first — anchor to scope invariant

## Goal

Diff-enumerated ACs that name the proposal file as one of the expected paths
in `git diff --name-only main...HEAD` are structurally fragile in the
proposal-elaboration → work two-phase workflow. When the proposal commit lands
on `main` *before* the implementation slot forks (the common case for
medium/large tasks), `main...HEAD` returns only the implementation paths —
the proposal is no longer ahead of `main`. The literal four-path enumeration
silently fails through no fault of the coder.

`task-9cd6cdb9` (PR #490, `orchestration-patterns lockstep + stash-prod`) hit
this in round 1. The reviewer correctly flagged via REQUEST_CHANGES; the
coder reconciled by editing the proposal in the same PR (commit `a2dd03b`:
clarifier + awk-syntax fix + AC12 Recovery clause), which put the proposal
path back into `main...HEAD`. The proposal author had even pre-written an
in-line Recovery clause anticipating the failure mode — but the structural
fix (normalising the recovery into the reference doc so future proposals
don't keep re-authoring the same fragile literal-four-path enumeration) was
never landed.

This proposal lands the structural fix at the **reference-doc layer**, where
the user's standing pattern (`feedback_reference_layer_not_inline.md`) places
contract-heavy AC guidance. The worker prompt already hooks into the
reference doc ("when the task's ACs are unusually contract-heavy, consult
`docs/ac-rigor-reference.md`"); we add a sibling `### ` clause to the
Verification-evidence family that future draft-proposal-worker invocations
will pick up via that hook.

Linked: task-9cd6cdb9 retrospective; PR #490; auto-memory
`feedback_proposal_in_diff_ac_stale_when_proposal_on_main.md`.

## Acceptance Criteria

- [ ] AC1 — A new `### ` clause is appended to
      `docs/ac-rigor-reference.md` under `## Verification-evidence family`,
      titled exactly `### Proposal-path enumeration goes stale when proposal
      commits to main first — anchor to scope invariant`, as a sibling of
      the existing `### Diff-enumerated verification lines go stale —
      anchor to invariants, not snapshots`. Falsifier: `awk
      '/^## Verification-evidence family/,/^## /' docs/ac-rigor-reference.md
      | grep -F "### Proposal-path enumeration goes stale when proposal
      commits to main first"` returns one line; the same `awk` slice also
      contains `### Diff-enumerated verification lines go stale`.
- [ ] AC2 — The new clause body names the failure mode in literal terms:
      the proposal commit lands on `main` *before* the implementation
      branch forks, so `git diff --name-only main...HEAD` returns only the
      implementation paths and a literal four-path enumeration of paths
      including the proposal file silently misses one. Falsifier (within
      the new clause's text range): `grep -F "before the implementation"`
      OR `grep -F "before the implementation branch"` returns a hit.
- [ ] AC3 — The new clause prescribes the (b)-form load-bearing invariant
      as the durable AC shape: an *implementation-path scope invariant*
      ("no `src/**`, `scripts/**`, `templates/**`, or `*.test.ts` paths
      appear in `git diff --name-only main...HEAD`"-style enumeration of
      what must NOT be in the diff) rather than a literal enumeration of
      paths that must be in the diff. The clause explicitly contrasts the
      two shapes — "what's NOT in the diff" survives a merge-base advance;
      "exactly these paths are in the diff" doesn't. Falsifier: the new
      clause contains the literal phrase `scope invariant` AND at least
      one of `no src/`, `no source/`, or `no `\``src/**`\` (one is sufficient).
- [ ] AC4 — The new clause cites `task-9cd6cdb9` and `PR #490` (or
      `pull/490`) as the precipitating instance, in the same clause body
      (one sentence is sufficient). Falsifier: `grep -F "task-9cd6cdb9"
      docs/ac-rigor-reference.md` AND (`grep -F "PR #490"
      docs/ac-rigor-reference.md` OR `grep -F "pull/490"
      docs/ac-rigor-reference.md`) both return ≥1 hit, and both hits land
      between the new clause's `### ` heading and the next `### ` or `## `
      heading.
- [ ] AC5 — The new clause cross-links the sibling `### Diff-enumerated
      verification lines go stale — anchor to invariants, not snapshots`
      clause, in the same toolset / distinct trigger style modelled on the
      stash-prod ↔ stash-and-rerun cross-link (clause body of `Stash-prod
      mutation test` already cites `No-regression framing when the gate
      baseline is red` reciprocally). The cross-link names the distinction
      explicitly: same toolset (`git diff --name-only main...HEAD`),
      distinct trigger (within-branch growth vs cross-branch merge-base
      advance). Falsifier (within the new clause's text range): `grep -F
      "Diff-enumerated"` returns a hit AND one of `same toolset` /
      `distinct trigger` / `merge-base` appears in the same paragraph.
- [ ] AC6 — The new clause prescribes the recovery pattern: a same-PR
      proposal edit (any substantive change — a clarifier, a recovery
      clause, an awk-syntax fix) puts the proposal path back into
      `main...HEAD` and reconciles the literal enumeration with the
      invariant, so a coder who hits the failure mode mid-round has a
      mechanical out without re-opening the proposal phase. Falsifier
      (within the new clause's text range): `grep -E "same[ -]PR"
      docs/ac-rigor-reference.md` returns ≥1 hit.
- [ ] AC7 — `skills/worker-conventions.md`'s Verification-evidence family
      pointer (currently the third bullet under `## AC verification rigor`,
      grouped as "Process-around-the-AC") is updated to list the new
      clause's title alongside the existing `Diff-enumerated verification
      lines go stale — anchor to invariants, not snapshots` clause.
      Falsifier: `grep -F "Proposal-path enumeration goes stale when
      proposal commits to main first" skills/worker-conventions.md`
      returns ≥1 hit.
- [ ] AC8 — The clause-count line (currently
      `docs/ac-rigor-reference.md:5` — "sixteen clauses across five
      thematic families") is updated from `sixteen` to `seventeen`.
      Falsifier: `grep -F "sixteen clauses" docs/ac-rigor-reference.md`
      returns 0 hits AND `grep -F "seventeen clauses"
      docs/ac-rigor-reference.md` returns ≥1 hit.
- [ ] AC9 — Negative control on worker prompt: `skills/ludics-draft-
      proposal-worker.md` is NOT modified. The worker prompt's existing
      "consult `docs/ac-rigor-reference.md` when ACs are contract-heavy"
      hook stays the entry point; AC-shape guidance lives at the reference
      layer per `feedback_reference_layer_not_inline.md`. Falsifier (a
      breach of the negative control): `git diff --name-only main...HEAD`
      includes `skills/ludics-draft-proposal-worker.md`.
- [ ] AC10 — Doc-only PR scope invariant (the (b)-form this proposal is
      itself prescribing — eats its own dog food): no `src/**`, no
      `scripts/**`, no `templates/**`, no `*.test.ts`, and no
      `docs/proposals/**` (other than this proposal file) path appears in
      `git diff --name-only main...HEAD`. Falsifier (a breach of the
      invariant): `git diff --name-only main...HEAD | grep -E
      '^(src/|scripts/|templates/|.*\.test\.ts$)'` returns ≥1 hit.

## Context

### Touch sites (verified)

- `docs/ac-rigor-reference.md` — append a new `### ` clause inside
  `## Verification-evidence family`, as a sibling of `### Diff-enumerated
  verification lines go stale — anchor to invariants, not snapshots`
  (currently around line 85). The clause-count line (currently line 5)
  also updates from `sixteen` to `seventeen`.
- `skills/worker-conventions.md` — extend the Verification-evidence-family
  pointer (third bullet under `## AC verification rigor`, currently
  grouped as "Process-around-the-AC") to list the new clause's title
  alongside the existing diff-enumerated clause. One-line edit.

### Touch site that is NOT modified (negative control)

- `skills/ludics-draft-proposal-worker.md` — explicitly out of scope.
  The worker prompt deliberately doesn't carry AC-shape templates; its
  "consult `docs/ac-rigor-reference.md`" hook (currently around line 105)
  is the entry point, and modifying the prompt to inline scope-AC
  guidance would contradict the user's standing reference-layer pattern
  (`feedback_reference_layer_not_inline.md`).

### Style precedent for the cross-link

The `### Stash-prod mutation test` clause models the pattern: it cites
`No-regression framing when the gate baseline is red` reciprocally with
"Same toolset … but a distinct probe: stash-and-rerun answers …, while
stash-prod answers …" — and notes "a reader landing on either clause
should follow the cross-link to find the other." The new clause uses
the same shape: same toolset (`git diff --name-only main...HEAD`),
distinct trigger (within-branch growth covered by the existing diff-
enumerated clause; cross-branch merge-base advance covered by the new
one).

### Why the (b)-form invariant, not the literal enumeration

The original task's Tentative Design (lines 81–157) framed the choice as
"three options ranked by leverage" and concluded that the
reference-doc clause is the right primary fix. The (b)-form invariant
("no source/test/schema paths in diff") is enumeration-tolerant: it
holds whether the proposal commit landed on `main` first or not, because
it's expressed in terms of what must *not* appear in the diff rather
than what must. AC10 of this proposal eats its own dog food by stating
its scope invariant in exactly that shape.

### Cross-references already resolved

- Auto-memory `feedback_proposal_in_diff_ac_stale_when_proposal_on_main.md`
  in the coder's project memory captures the recovery from the working
  side; this proposal promotes the essence of that auto-memory to the
  reference doc so future *proposal authoring* avoids the latent bug.
- `feedback_reference_layer_not_inline.md` — the user's standing pattern
  for AC-shape guidance: reference doc, not skill template body.
- `feedback_competent_swe_filter.md` — the new clause is a structural
  workflow fix (recurring failure mode in the two-phase workflow), not
  a hygiene-flavoured suggestion; the filter passes.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Append the new `### ` clause to `docs/ac-rigor-reference.md` inside
   `## Verification-evidence family`, immediately after the existing
   `### Diff-enumerated verification lines go stale — anchor to
   invariants, not snapshots` clause (one paragraph, prose-only, in the
   same dense-prose voice as the surrounding clauses). Hit AC2, AC3,
   AC4, AC5, AC6 in the body; satisfy AC1's structural placement.
2. Update line 5's "sixteen clauses" to "seventeen clauses" (AC8). The
   "five thematic families" count is unchanged — the new clause is a
   sibling within the existing Verification-evidence family.
3. Edit `skills/worker-conventions.md`'s Verification-evidence-family
   pointer to list the new clause title (AC7). One-line addition, same
   semicolon-separated style as the existing list of clauses in that
   bullet.
4. Verify AC9 (worker prompt unchanged) and AC10 (no `src/**` /
   `scripts/**` / `templates/**` / `*.test.ts` paths in the diff) by
   running the falsifier greps locally before committing.
5. The reciprocal cross-link from the existing `### Diff-enumerated
   verification lines go stale` clause to the new one is *optional*
   under this proposal's ACs — desirable for symmetry with the
   stash-prod ↔ stash-and-rerun precedent, but the absorb-vs-follow-up
   judgement (per `worker-conventions.md` § Scope) belongs to the
   coder. If absorbed, it's a one-sentence addition to that clause.

## Scope

**In scope.**

- `docs/ac-rigor-reference.md`: new `### ` clause + clause-count update.
- `skills/worker-conventions.md`: one-line pointer addition.

**Out of scope.**

- `skills/ludics-draft-proposal-worker.md` — explicit negative control
  (AC9). The worker prompt is not modified.
- Any code changes (`src/**`, `scripts/**`, `templates/**`, `*.test.ts`)
  — explicit negative control (AC10). Doc-only PR.
- Any other clause additions, taxonomy reshuffling, or family
  reorganisation in `docs/ac-rigor-reference.md`. The new clause is
  additive and lives inside the existing Verification-evidence family.
- General revision of all `main...HEAD`-based ACs across past proposals.
  Out of scope per the task's Notes section ("Scope of 'diff-enumerated
  ACs'").

**Dependencies.** None. `task-9cd6cdb9` is `relates_to`, not blocking;
PR #490 has already merged.
