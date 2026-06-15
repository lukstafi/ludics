# Emit a staging_outbound_* event on the dirty-worktree skip path so downtime is distinguishable from a blocked worktree

## Goal

The outbound staging→upstream push tick skips its work when the staging
worktree is dirty (`src/staging-ff.ts:362–366`, inside
`syncUpstreamMainFromStaging`) and — unlike every other skip/failure branch —
emits no event and does not touch the sentinel. So a persistently dirty
`~/<repo>` worktree ages the sentinel past the staleness threshold with **zero**
`staging_outbound_*` events, and `classifyOutboundStaleness`
(`src/staging-event-meta.ts:198–212`, added by task-c4aedd6b) mis-reads that as
`no-attempts` — telling the operator the controller/keepalive is down when the
real cause is a blocked checkout they could clear in seconds. This task closes
that seam: the dirty-skip branch emits a `staging_outbound_skipped_dirty` event,
and the classifier gains a dedicated `kind: "blocked-worktree"` that fires when
the only in-window outbound activity is that skip event, returning a
single-sourced "commit / stash / clean `~/<repo>`" remedy. The fix preserves the
no-sentinel-touch policy (so the stale-sentinel health finding still fires) and
must not regress the genuine-downtime → `no-attempts` diagnosis.

Task: `task-cabf6402` (Ludics). Provenance: retrospective of `task-c4aedd6b`
(Codex P2 comment on PR #566, deferred there as out-of-scope).

## Acceptance Criteria

1. **Event emission on the dirty-skip path.** When the outbound tick reaches the
   dirty-worktree skip branch of `syncUpstreamMainFromStaging`, it emits one
   `staging_outbound_skipped_dirty` event for the project (via the existing
   `opts.emitEvent?.` seam) before continuing — carrying the structured project
   and a self-describing message naming the dirty `~/<repo>` worktree. The event
   type fits the existing `staging_outbound_<reason>` family and flows through the
   Mag adapter (`runStagingOutboundPushTick`) unchanged, so it lands in
   `journal/events.jsonl` with `event_type`, `project`, and `message` like the
   other outbound events.

2. **Sentinel-untouched policy preserved.** The dirty-skip branch still does NOT
   touch the outbound sentinel — the sentinel must keep aging so the
   stale-sentinel health finding continues to fire on a persistently dirty
   worktree. (The existing "dirty worktree: sentinel NOT touched, no push" test
   invariant remains green; the only added behavior is the event.)

3. **New `blocked-worktree` classification.** `classifyOutboundStaleness` returns
   a new `{ kind: "blocked-worktree", remedy }` when the **only** in-window
   outbound activity for the project is the `staging_outbound_skipped_dirty`
   event — i.e. the tick ran, hit a dirty tree, and made no real push attempt.
   The remedy directs the operator to commit / stash / clean `~/<repo>` (the
   blocked checkout), not to investigate controller liveness.

4. **Precedence invariants preserved.** The new kind slots into the existing
   precedence without disturbing the other three outcomes:
   - genuine downtime (zero `staging_outbound_*` events in the window) still →
     `no-attempts` (the OCANNL-incident case must not regress);
   - an in-window auth-failure event (workflow-scope / credentials) still →
     `auth`, and auth **takes precedence** even when a dirty-skip event is also
     present in the window;
   - any other real in-window tick activity (e.g. `staging_outbound_fast_forwarded`,
     `staging_outbound_error`, or a dirty-skip event accompanied by such real
     activity) still → `unknown`. Only the "the sole in-window activity is the
     dirty-skip event" case is the new `blocked-worktree`.

5. **Remedy single-sourcing.** The `blocked-worktree` remedy string lives in
   `src/staging-event-meta.ts` beside `OUTBOUND_EVENT_CAUSE_REMEDY` /
   `NO_ATTEMPTS_REMEDY` (the single-source convention task-c4aedd6b established).
   It is NOT duplicated into `src/mag.ts` or into `skills/ludics-health-check.md`.

6. **CLI surfacing.** The `ludics mag outbound-cause-remedy <project>` subcommand
   surfaces the new kind in its emitted JSON (a `{ "kind": "blocked-worktree",
   "remedy": ... }` object) — flowing through unchanged because it already prints
   `classifyOutboundStaleness`'s result verbatim.

7. **Health-check surfacing.** The `check-outbound-staging-ff` step in
   `skills/ludics-health-check.md` annotates a `blocked-worktree` finding with the
   remedy using the same annotation shape it already uses for the other kinds
   (e.g. the `— cause: …; remedy: …` / `— <remedy>` arm), reading the remedy from
   the CLI output rather than embedding it in the markdown.

8. **Unit coverage incl. negative controls.** Tests cover: emission on the
   dirty-worktree branch (`src/staging-ff.test.ts` — alongside the existing
   no-touch invariant); the `blocked-worktree` classification firing on a
   dirty-skip-only window (`src/staging-event-meta.test.ts`); a **negative
   control** that real in-window activity (fast-forward / error) does NOT yield
   `blocked-worktree` (stays `unknown`); a **negative control** that zero in-window
   activity stays `no-attempts`; and an **auth-takes-precedence boundary** test
   (a dirty-skip event plus an in-window auth-failure event → `auth`, not
   `blocked-worktree`).

9. **No regressions.** `bun test`, `lint:cli-subcommands` (no subcommand is added —
   `outbound-cause-remedy` already exists — so parity continues to hold), and the
   rest of the lint suite pass.

## Context

**Provenance.** Auto-generated from the retrospective of `task-c4aedd6b`, which
added the `auth` / `no-attempts` / `unknown` classifier and explicitly left
`staging-ff.ts` event-emitter changes out of scope. Codex flagged the resulting
gap as a P2 comment on PR #566. The decision to take the richer Option B (a
dedicated `blocked-worktree` kind rather than a silent `unknown` degrade) was
resolved by the user on 2026-06-15 (see the task's `## Questions` block): keep
faith with task-c4aedd6b's intent that this finding be **diagnostic** rather than
silent.

**Verified code pointers** (`~/ludics` @ `origin/main`, PR #566 merged at
`9afbfef`):

- `src/staging-ff.ts:362–366` — the dirty-worktree skip branch:
  ```ts
  if (!worktreeClean(path, opts.runGit)) {
    out.push({ project, outcome: "skipped-dirty-worktree" });
    // No sentinel touch — same policy as inbound (transient user state).
    continue;
  }
  ```
  Sibling branches in the same function already emit events via
  `opts.emitEvent?.({ type, project, message })` (e.g. the credentials/error
  branches at `src/staging-ff.ts` ~329–349) — this branch is the only one that
  doesn't. The `OutboundPushOutcome` union already carries
  `"skipped-dirty-worktree"`; the new `staging_outbound_skipped_dirty` symbol is a
  separate *event_type* string, not a new outcome.
- `src/staging-event-meta.ts` — `OUTBOUND_EVENT_PREFIX = "staging_outbound_"`
  (line 17); `outboundActivitySince` (lines 144–178) matches **any**
  `staging_outbound_*` event in the window (so the new event already counts as
  "tick ran"); `classifyOutboundStaleness` (lines 198–212) with order
  auth → no-attempts → unknown; `OUTBOUND_EVENT_CAUSE_REMEDY` (line 31),
  `NO_ATTEMPTS_REMEDY` (line 49), and the `OutboundStaleClassification` union
  (lines 53–56); `latestOutboundCauseRemedy` (lines 83–133) is the
  newest-qualifying-event reader the auth branch uses.
- `src/mag.ts` — `runStagingOutboundPushTick` forwards `ev.type → event_type`,
  `ev.project → project`, `ev.message`, and spreads `ev.extra` into the persisted
  `LudicsEvent` (~lines 2173–2191); the `outbound-cause-remedy` subcommand handler
  prints `classifyOutboundStaleness`'s result verbatim (~lines 4430–4445).
- `skills/ludics-health-check.md` — the `check-outbound-staging-ff` annotation
  block (lines 155–196) reads `kind` from the CLI JSON and branches on `auth` /
  `no-attempts` / `unknown`.
- Existing tests: `src/staging-ff.test.ts:893` ("dirty worktree: …, sentinel NOT
  touched, no push") and `src/staging-event-meta.test.ts:164–242`
  (`classifyOutboundStaleness` describe block) — match their style.

**Out of scope (explicit):**

- **No state-migration test-triple.** Verified: `lint:state-migration`
  (`scripts/lint-state-migration.ts`) guards a fixed `PERSISTED_TYPES` allowlist
  of **interface** declarations against `state.shape.snapshot.json` and its
  extractor only recognises `interface X {` / `export interface X {` forms.
  Neither a new `staging_outbound_*` JSONL **event_type** string (an append-only
  log record with no migrator) nor the string-literal `OutboundStaleClassification`
  union is on the allowlist or extractable by it, so the positive-backfill /
  negative-control / JSON-round-trip triple is not triggered. The coder should not
  chase it.
- **No sentinel-policy change.** The no-sentinel-touch behavior on the dirty-skip
  path is deliberately preserved (AC 2); this task only adds an event + a
  classification, it does not start touching the sentinel.

## Approach

The change is small and the design is fully decided; an implementation-plan phase
adds little. Concrete shape:

1. **Emission seam (`src/staging-ff.ts`).** In the dirty-worktree branch, add
   `opts.emitEvent?.({ type: "staging_outbound_skipped_dirty", project, message:
   `${project}: outbound skipped — ~/<repo> worktree dirty` })` immediately before
   the `continue`, leaving `out.push({ project, outcome: "skipped-dirty-worktree"
   })` and the no-sentinel-touch comment intact.

2. **Classifier branch + ordering (`src/staging-event-meta.ts`).**
   - Extend the `OutboundStaleClassification` union with
     `| { kind: "blocked-worktree"; remedy: string }`.
   - Add a `BLOCKED_WORKTREE_REMEDY` const beside `NO_ATTEMPTS_REMEDY`
     (e.g. "the outbound tick is skipping because `~/<repo>` has a dirty worktree —
     commit / stash / clean it so the push can run").
   - In `classifyOutboundStaleness`, keep the existing order: try `auth` first
     (so auth takes precedence over a co-present dirty-skip event), then check
     activity. When activity exists, distinguish "the only in-window outbound
     activity is `staging_outbound_skipped_dirty`" → `blocked-worktree`, from
     "other/real activity present" → `unknown`. This needs a small reader that
     reports whether the in-window outbound activity is *exclusively* the
     dirty-skip type — mirror the existing `outboundActivitySince` /
     `latestOutboundCauseRemedy` scan style (best-effort, project-match via
     structured field with `"<project>:"` message-prefix fallback, `epoch >=
     sinceEpoch` window). Keep `no-attempts` for zero activity unchanged.

3. **CLI consumer (`src/mag.ts`).** No code change required for the
   `outbound-cause-remedy` handler — it already `JSON.stringify`s the
   classification verbatim, so the new kind flows through. (Verify this in review;
   if any kind-specific narrowing exists, extend it to pass `blocked-worktree`
   through.)

4. **Health-check skill (`skills/ludics-health-check.md`).** Add a
   `blocked-worktree` arm to the `check-outbound-staging-ff` annotation block that
   appends the CLI-returned `remedy` to the finding text using the existing
   annotation shape (e.g. `finding_text="$finding_text — $remedy"`, as the
   `no-attempts` arm does). No remedy prose in the markdown.

5. **Tests.** In `src/staging-ff.test.ts`, assert the dirty-worktree branch emits
   exactly one `staging_outbound_skipped_dirty` event for the project while the
   sentinel stays untouched and no push happens. In
   `src/staging-event-meta.test.ts`, add to the `classifyOutboundStaleness`
   describe: dirty-skip-only window → `blocked-worktree` with the single-sourced
   remedy; dirty-skip + real activity → `unknown` (negative control); zero
   activity → `no-attempts` (negative control); dirty-skip + in-window auth
   failure → `auth` (precedence boundary). Follow the existing `tmpEvents([...])`
   fixture and `result.kind` narrowing style.
