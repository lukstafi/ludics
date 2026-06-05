# Outbound staging-ff: classify workflow-scope push rejection distinctly (don't throttle, surface real cause)

## Goal

When the outbound staging→upstream fast-forward push tick
(`syncUpstreamMainFromStaging` in `src/staging-ff.ts`, wrapped by
`runStagingOutboundPushTick` in `src/mag.ts`) is rejected by GitHub because the
push token lacks the `workflow` OAuth scope, the failure is misclassified as the
catch-all `"other"` → outcome `error`. That path **touches the sentinel**
(`last-outbound-fast-forward-<project>.epoch`), suppressing any retry for 24h
even though the remedy (`gh auth refresh -h github.com -s workflow`) takes
seconds, and it emits only a generic `staging_outbound_error` event whose real
cause (`without 'workflow' scope`) lives only in keepalive stderr — invisible to
the events log, health-check, and briefing-lag surfaces.

This rejection has been observed twice (events.jsonl 2026-05-31, 2026-06-05). It
fires whenever a commit in the fast-forward range edits a `.github/workflows/`
file and the push token lacks the `workflow` scope — a real, recurring,
*actionable* failure mode that the current "vague daily failure + 24h throttle"
handling actively hides.

The fix is a tightly-scoped mirror of the existing credentials
"don't-throttle + surface" path: recognize this rejection as its own class,
skip the sentinel touch (so the next tick retries and the stale-sentinel health
signal stays armed), and name the cause + remedy in the emitted event and in the
programmatic annotation layer that the health-check / briefing-lag surfaces
consume. Q2 broadens the annotation work to also cover the symmetric
credentials gap, since it rides the identical code path.

Task: `task-35e74651` (Ludics).

## Acceptance Criteria

1. A push rejection caused by a missing `workflow` OAuth/PAT scope is
   classified as its own class, distinct from `credentials`, `network`, and
   `other`. The classifier recognizes GitHub's literal rejection text
   (`refusing to allow an OAuth App to create or update workflow ... without
   'workflow' scope`, and the fine-grained-PAT variant `without 'workflow'
   scope`), tolerating both ASCII-quote and backtick quoting around `workflow`.
   The new class is matched ahead of (or otherwise wins over) the `credentials`
   and `network`/`other` classes for this text, so the more specific, more
   actionable class is chosen.

2. When the outbound push fails for this reason, `syncUpstreamMainFromStaging`:
   - reports a distinct outcome (mirroring `skipped-no-push-credentials`,
     e.g. `skipped-no-workflow-scope`) on the project result,
   - emits a distinct event (e.g. `staging_outbound_workflow_scope_missing`)
     whose message names both the cause (push token lacks the `workflow`
     scope) and the remedy (`gh auth refresh -h github.com -s workflow`), and
   - does **NOT** touch the outbound sentinel, so the next keepalive tick
     retries and the stale-sentinel health signal stays armed.

3. The new outcome is included in the set of `runStagingOutboundPushTick`
   outcomes that get logged to stderr (alongside `pushed`,
   `skipped-not-fast-forward`, `skipped-no-push-credentials`,
   `skipped-local-staging-behind`, `error`).

4. The programmatic precompute layer that produces the stale-outbound-sentinel
   surface (the `outbound-staging-ff-stale:<project>` finding in the
   health-check skill and the matching annotation in the briefing-lag section)
   attaches a **cause + remedy** annotation read from the most recent relevant
   outbound event for the project:
   - a `staging_outbound_workflow_scope_missing` event →
     cause "push token lacks `workflow` scope",
     remedy `gh auth refresh -h github.com -s workflow`;
   - a `staging_outbound_credentials_missing` event (symmetric, in-scope per
     Q2) → cause "missing/invalid push credentials" and the credentials-refresh
     remedy.
   The annotation is carried by the precomputed data the surface already
   consumes — **not** by adding prose/instructions to
   `skills/ludics-health-check.md`. The skill markdown stays unchanged (it
   renders the extra field only if present); no skill-markdown bloat.

5. The two read-only fetch-failure branches (fetch upstream, fetch origin) are
   not required to grow the new class — a workflow-scope rejection is a
   push-only failure — but the classifier itself must still return the new
   class consistently regardless of caller (it is a pure function).

6. Tests mirror existing coverage:
   - **Positive**: a workflow-scope rejection routed through
     `syncUpstreamMainFromStaging` yields the new outcome, the new event is
     emitted, and the sentinel is **NOT** touched.
   - **Negative control**: a plain non-fast-forward rejection
     (`! [remote rejected] ... (non-fast-forward)`) still classifies as
     `other` → `error` and **DOES** touch the sentinel — proving the new class
     is narrow and the throttle still applies to genuinely-stuck cases.
   - Classifier unit cases for both quote variants and the OAuth-App vs.
     PAT phrasings.
   - The annotation layer is covered by a unit test that, given a recent
     workflow-scope (and a credentials) outbound event, produces the expected
     cause + remedy fields; and a control where no such event yields no
     annotation.

## Context

How things work now (all symbols in the Ludics repo, `/Users/lukstafi/ludics`):

- **`src/staging-ff.ts`**
  - `classifyPushFailure(stdout, stderr)` — pure classifier returning
    `"credentials" | "network" | "other"`. It lowercases `${stdout}\n${stderr}`,
    checks a credentials regex first (it deliberately runs before the network
    regex so a two-line GitHub 403 stderr classifies as `credentials`), then a
    network regex, then falls through to `other`. The new class is added to the
    union and matched here. The rejection text lives in **stderr** and the push
    exits non-zero, both already inspected by this function.
  - `OutboundPushOutcome` union — add a variant mirroring
    `skipped-no-push-credentials`.
  - `syncUpstreamMainFromStaging` step **(E)** — the push-result branch after
    `const kind = classifyPushFailure(pushed.stdout, pushed.stderr)`. Today it
    is a two-way `if (kind === "credentials") { skipped-no-push-credentials +
    staging_outbound_credentials_missing event + NO sentinel } else { error +
    staging_outbound_error event + touchSentinel }`. The new class adds a
    branch that pushes the new outcome, emits the new event, and does **not**
    call `touchSentinel`. The credentials branch is the exact template for the
    "don't-throttle + surface" shape.

- **`src/mag.ts`**
  - `runStagingOutboundPushTick` — the post-loop `for (const r of results)`
    block lists the outcomes that get a `console.error` stderr line; add the new
    outcome to that set.
  - The `emitEvent` adapter inside `runStagingOutboundPushTick` currently
    forwards `{ event_type: ev.type, source, scope, message, ...ev.extra }`.
    **Note for the annotation work (AC 4):** the persisted event record does
    **not** carry a structured `project` field — `staging-ff.ts` embeds the
    project name only in the `message` string. So matching "the most recent
    relevant outbound event *for this project*" either requires parsing the
    message prefix or (cleaner) threading the project name through `ev.extra`
    so the persisted record gains a structured `project` field. Prefer the
    structured field; it makes the annotation lookup robust and is a one-line
    addition at each `emitEvent?.(...)` call site.

- **The programmatic stale-sentinel surface** is split across two consumers
  that read the same sentinel file (`last-outbound-fast-forward-<project>.epoch`):
  - `src/briefing-lag.ts` — `outboundSentinelStaleNote(...)`, called from
    `formatUpstreamLagSection`, emits the "outbound sentinel is ~Nh old;
    upstream push may be overdue" line into the briefing context. This is the
    natural programmatic home for the cause + remedy annotation: it already
    reads the sentinel mtime, runs in `src/`, and is unit-tested
    (`src/briefing-lag.test.ts`). Extend it to read the most recent relevant
    outbound event for the project and append the cause + remedy to the note.
  - `skills/ludics-health-check.md` § `check-outbound-staging-ff` — computes
    the `outbound-staging-ff-stale:<project>` finding **inline in skill bash**
    (sentinel mtime + config lookup); there is no `src/` precompute that
    produces *that* finding today. Per Q1/Q2 the skill markdown must stay free
    of new prose; it should only render an extra cause/remedy field **if
    present**. Surfacing the annotation to the health-check finding therefore
    means exposing the cause/remedy through prep data the skill can read
    (e.g. a small lookup the skill already has access to, or by reusing the
    same event-lookup the briefing-lag note uses). See Scope for the
    flagged ambiguity here.

- **Events** (`src/events.ts`) — `emitEvent` appends to
  `journal/events.jsonl`; the query path (`eventsQuery`) reads the file but
  there is no exported "latest event of type T (optionally scoped to project
  P)" helper. The annotation layer needs a small read helper (or to reuse the
  query path) to fetch the most recent
  `staging_outbound_workflow_scope_missing` / `staging_outbound_credentials_missing`
  event.

- **Tests** — `src/staging-ff.test.ts` already has a
  `classifyPushFailure` describe (quote/phrasing unit cases) and a
  `classifyPushFailure end-to-end` describe with the
  "403 push failure → skipped-no-push-credentials, sentinel NOT touched"
  template (uses `outboundFakeGit({ push: { stderr, exitCode } })` and asserts
  `existsSync(sentinel) === false`). `src/mag.test.ts` has a
  `runStagingOutboundPushTick` describe (gates/outcomes; the stderr-logging set
  is not currently asserted, so a test there is optional). `src/briefing-lag.test.ts`
  covers the existing outbound-stale annotation.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The classifier + outcome + event + no-throttle plumbing (ACs 1–3, 5–6) is a
mechanical mirror of the existing credentials path and the matcher is well
specified (anchor on `without 'workflow' scope` and/or the quote-agnostic
`create or update workflow`, matched before credentials/network/other). This
part is straightforward.

The annotation layer (AC 4) is the only part with a design choice — see Scope.
The recommended shape: add the structured `project` field to the outbound
events, add a small "latest matching outbound event" reader, and have
`src/briefing-lag.ts` (and whatever prep data the health-check skill reads)
attach the cause + remedy from that event. Keep the cause/remedy strings in one
shared map keyed by event type so the workflow-scope and credentials cases stay
in sync.

## Scope

In scope:
- New push-failure class + outcome + event + no-sentinel-touch routing for the
  workflow-scope rejection (step E of `syncUpstreamMainFromStaging`).
- stderr-logging set update in `runStagingOutboundPushTick`.
- Cause + remedy annotation in the programmatic stale-sentinel surface for
  **both** the workflow-scope event and the symmetric
  `staging_outbound_credentials_missing` event (Q2 — folded in, no separate
  follow-up).
- Tests mirroring the existing credentials/end-to-end coverage, including a
  non-fast-forward negative control that still throttles.

Out of scope:
- Any new prose or instructions in `skills/ludics-health-check.md` (Q1: skill
  markdown stays unchanged — render-if-present only).
- The read-only fetch-failure branches' two-way credentials/error split (a
  workflow-scope rejection cannot occur on a read-only fetch).
- The immediate operational fix for OCANNL's blocked push (refresh the token's
  `workflow` scope) — that is an operator action, not code.

**Flagged ambiguity (AC 4 surface):** the task's resolved Q1 assumes a single
"programmatic precompute that produces the `outbound-staging-ff-stale:<project>`
finding". In the current code there are **two** distinct surfaces: a `src/`
function (`outboundSentinelStaleNote` in `src/briefing-lag.ts`, briefing
context) and an **inline-bash** computation in the health-check skill (no `src/`
precompute backs that finding). `src/briefing-lag.ts` is the unambiguous home
for the annotation. Wiring the same cause/remedy into the health-check skill's
finding without adding skill prose requires either (a) exposing the annotation
as prep data the skill reads (a small new lookup the skill can call) or (b)
accepting that the briefing-lag annotation is the primary programmatic surface
and the health-check skill renders the field only where it already has the
data. Agents should pick the minimal wiring consistent with "no skill-markdown
bloat" and surface the choice in their plan; if the health-check side proves to
need more than a render-if-present field, prefer scoping the annotation to the
briefing-lag surface and note the gap rather than expanding the skill.
