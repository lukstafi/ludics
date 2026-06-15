# Make the outbound-staging-ff health-check finding diagnostic: auth cause+remedy annotation AND downtime-vs-auth distinction

## Goal

When the health-check raises `outbound-staging-ff-stale:<project>` (the outbound
staging→upstream fast-forward sentinel has gone stale), the finding should tell
an operator **why** the sentinel is stale rather than leaving them to guess.
Today the finding is computed inline in `skills/ludics-health-check.md` bash and
carries no cause/remedy — and a live OCANNL incident (2026-06-15) showed the two
real causes need to be distinguished: an **auth gap** (a push token missing the
`workflow` scope or invalid credentials, where a recent outbound *failure* event
names a copy-pasteable remedy) versus the **once-daily outbound tick simply not
running** (controller/keepalive downtime, where there are *no* outbound events
at all and the auth annotation would have been empty exactly when guidance was
needed). This task gives the finding a thin programmatic seam — a `ludics mag`
JSON subcommand that classifies the staleness into `auth` / `no-attempts` /
`unknown` and returns the matching annotation — so the skill can append the
right guidance with no cause/remedy prose added to the skill markdown.

Task: `task-c4aedd6b` (Ludics).

## Acceptance Criteria

1. A `ludics mag` JSON subcommand, given a project name, classifies the current
   outbound-sentinel state for that project and prints a single JSON object to
   stdout: one of `{ "kind": "auth", "cause": ..., "remedy": ... }`,
   `{ "kind": "no-attempts", "remedy": ... }`, or `{ "kind": "unknown" }` (the
   last carrying no annotation). It resolves the events file and the sentinel
   path from the harness directory exactly as the existing surfaces do, computes
   `sinceEpoch` from the sentinel mtime to match the briefing-lag boundary
   semantics, and is best-effort (missing/empty events or sentinel never throws —
   it yields `unknown` or `no-attempts` as appropriate).

2. The health-check `check-outbound-staging-ff` step, for each opted-in project
   that produced a finding, invokes the subcommand and appends the returned
   `remedy` (and `cause` when present) to the finding text in the **same wording
   the briefing-lag arm uses** (`— cause: <cause>; remedy: <remedy>` for auth;
   `— <remedy>` for no-attempts). **No cause/remedy prose is written into the
   skill markdown** — every annotation string originates from the CLI output.
   When the subcommand returns `unknown`, no annotation is appended and the
   finding text is unchanged. This preserves the task-35e74651 AC4 constraint
   (skill markdown stays free of the cause/remedy strings; the seam carries them).

3. The **no-attempts** branch fires when the sentinel is stale and there are
   **zero** `staging_outbound_*` events for the project in the window (since
   `sinceEpoch`). Its remedy points at controller/keepalive liveness — e.g.
   "no outbound push attempts since <sentinel time> — the once-daily outbound
   tick is not running; verify the controller/keepalive is alive" — naming the
   downtime cause rather than a credential remedy.

4. The **auth** branch preserves the existing behavior: when
   `latestOutboundCauseRemedy` returns a non-null annotation for the project
   (workflow-scope or credentials gap) within the window, the subcommand returns
   that cause + remedy verbatim from `OUTBOUND_EVENT_CAUSE_REMEDY` — the same
   strings the briefing-lag arm and the event emitter share.

5. All remedy strings are **single-sourced in `src/`** beside
   `OUTBOUND_EVENT_CAUSE_REMEDY` in `src/staging-event-meta.ts` (including the
   new `no-attempts` remedy string) — none are duplicated into the skill markdown
   or into `src/mag.ts`.

6. The new subcommand is registered consistently in every CLI-parity site the
   lint enforces: the `magSubcommands` registry in `src/mag.ts` and the `mag`
   USAGE block in `src/index.ts` (the runMag unknown-command listing is derived
   programmatically from the registry keys, so it updates automatically — but
   `bun scripts/lint-cli-subcommands.ts` must pass).

7. Unit coverage exercises the classifier's three branches — `auth`,
   `no-attempts`, and `unknown` — as a pure function of (events, project,
   `sinceEpoch`), mirroring the `src/staging-event-meta.test.ts` style
   (`tmpEvents([...])` fixtures), including the boundary case where an obsolete
   pre-`sinceEpoch` failure must NOT produce `auth`, and a mixed state
   (non-failure outbound events present, sentinel still stale) yields `unknown`.

## Context

This is the deferred second surface of `task-35e74651` (PR
[#557](https://github.com/lukstafi/ludics/pull/557), merged 2026-06-05). That
task's AC4 named **two** surfaces for the outbound-push cause+remedy annotation:
the briefing-lag stale-sentinel note (`src/briefing-lag.ts`, implemented that
round) and the health-check `outbound-staging-ff-stale:<project>` finding
(deferred — the finding is computed inline in skill bash with no `src/`
read-boundary to attach precomputed data to, and AC4 forbids adding the
cause/remedy prose to the skill markdown). The reader already exists:
`latestOutboundCauseRemedy` / `OUTBOUND_EVENT_CAUSE_REMEDY` in
`src/staging-event-meta.ts` (covered by `src/staging-event-meta.test.ts`).

**Repurposed 2026-06-15 (user-approved).** A live OCANNL incident widened the
scope: `outbound-staging-ff-stale:OCANNL` fired at ~77h critical, but the cause
was **controller downtime** (mac-studio keepalive down/intermittent Jun 11→14, so
the once-daily outbound tick never ran), **not** an auth gap. There were **zero**
`staging_outbound_*` failure events, so `latestOutboundCauseRemedy` would have
returned `null` and the annotation would have been absent exactly when an
operator needed guidance. The by-hand diagnostic tell — *stale sentinel + zero
recent outbound events ⇒ uptime gap, not credentials* — is the signal worth
encoding. So the finding now classifies **auth vs downtime**, making it
genuinely diagnostic and non-redundant with the briefing-lag surface.

The seam choice was the only open design question; it is resolved (user-confirmed
2026-06-15): **seam (b), a thin `ludics mag` JSON subcommand** that the skill
bash calls, rather than standing up a precompute file + writer + read-boundary
for a single annotation. Rationale and the rejected seam (a) are recorded in the
task file's Tentative Design.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The annotation source of truth already lives in `src/staging-event-meta.ts`
(`OUTBOUND_EVENT_CAUSE_REMEDY` + `latestOutboundCauseRemedy`). The work is
classification + a thin CLI seam, in three small pieces:

1. **Classifier + activity scan in `src/staging-event-meta.ts`.** Beside the
   existing exports, add:
   - the `no-attempts` remedy string (a single exported constant, kept next to
     `OUTBOUND_EVENT_CAUSE_REMEDY` so all remedy strings live in one module);
   - a tiny pure helper, e.g. `outboundActivitySince(eventsFile, project,
     sinceEpoch)`, that counts/most-recent **any** `staging_outbound_*` event for
     the project since `sinceEpoch` — not just the two auth-failure types.
     This is what distinguishes "tick ran but was a no-op / non-auth outcome"
     from "tick never ran". The full event-type set emitted by
     `syncUpstreamMainFromStaging` in `src/staging-ff.ts` is:
     `staging_outbound_credentials_missing`, `staging_outbound_workflow_scope_missing`,
     `staging_outbound_error`, `staging_outbound_local_behind`,
     `staging_outbound_fast_forward_diverged`, `staging_outbound_fast_forwarded`
     — match by the `staging_outbound_` prefix so the scan stays robust to new
     outcome types. Reuse the same best-effort JSONL parsing, project-match
     (structured `project` field, `"<project>:"` message-prefix fallback), and
     `sinceEpoch` boundary semantics as `latestOutboundCauseRemedy`;
   - a pure classifier (it can live here too, given (events, project,
     sinceEpoch)) returning the discriminated union:
     `{ kind: "auth", cause, remedy }` when `latestOutboundCauseRemedy` is
     non-null; else `{ kind: "no-attempts", remedy }` when no outbound activity
     exists in the window; else `{ kind: "unknown" }`.

2. **Thin subcommand in `src/mag.ts`.** Add one entry to the `magSubcommands`
   registry (~line 4295), mirroring `auto-start-evaluate` (~line 4396): take the
   project name as `args[0]`, resolve `eventsFile = join(harnessDir(), "journal",
   "events.jsonl")` and the sentinel `join(harnessDir(), "mag",
   "last-outbound-fast-forward-<project>.epoch")` (same as `magContext` /
   `briefing-lag`), compute `sinceEpoch = floor(sentinelMtime/1000)` (missing
   sentinel → scan whole file), call the classifier, and
   `console.log(JSON.stringify(result))`. No new annotation logic in `mag.ts` —
   it only wires harness paths to the pure classifier.

3. **CLI-parity sites.** Register the subcommand name in `src/index.ts` USAGE
   (the `mag …` block, beside `mag auto-start-evaluate`). The runMag
   unknown-command listing is derived from `magSubcommands.keys()` (mag is
   `hasListing: false` in `scripts/lint-cli-subcommands.ts`), so it updates
   automatically — but run `bun scripts/lint-cli-subcommands.ts` to confirm
   parity.

4. **Minimal skill edit (prose-stable).** In `skills/ludics-health-check.md`
   §`check-outbound-staging-ff` (~lines 155–176), after the finding is
   classified, add one bash invocation of the subcommand per opted-in project and
   append the returned strings to the finding text (auth →
   `— cause: <cause>; remedy: <remedy>`, identical to the briefing-lag wording;
   no-attempts → `— <remedy>`; unknown → nothing). **Do not** write any
   cause/remedy text into the markdown — every string comes from the CLI output.

5. **Tests.** Cover the classifier's three branches in
   `src/staging-event-meta.test.ts` using the existing `tmpEvents([...])`
   fixtures: an auth event in-window → `auth`; an empty/old-only events file with
   a positive `sinceEpoch` → `no-attempts`; a non-auth `staging_outbound_*` event
   in-window (no auth failure) → `unknown`; plus the boundary control that an
   obsolete pre-`sinceEpoch` failure does not yield `auth`.

### Prose-stable constraint (explicit)

The cause/remedy/no-attempts strings must NOT appear in
`skills/ludics-health-check.md`. The skill edit is one subcommand invocation plus
an append of the returned strings — identical in shape to the briefing-lag arm —
so both surfaces stay phrased the same and there is a single source of truth in
`src/staging-event-meta.ts`. This is the task-35e74651 AC4 constraint and is the
reason for the CLI seam rather than inlining the strings.

### Edge cases (mirror the reader; don't reimplement)

- **Missing sentinel** (critical "never ran / removed"): no mtime → `sinceEpoch`
  scans the whole file; if there are no outbound events at all → `no-attempts`,
  which is the right diagnostic for a sentinel that never existed.
- **Obsolete failure before a later success**: `sinceEpoch = floor(mtime/1000)`
  drops it (existing `latestOutboundCauseRemedy` semantics), so it does not
  produce a stale `auth` remedy.
- **No matching / unparseable events file**: best-effort → no auth annotation;
  with zero activity in window → `no-attempts`.
- **Project name**: use the same `name` key for the sentinel path and the
  classifier so keys line up with the briefing-lag arm and the skill's
  `outbound_sync_enabled` project iteration.

## Scope

In scope:
- New `no-attempts` remedy constant + `outboundActivitySince` helper + pure
  classifier in `src/staging-event-meta.ts`.
- Thin `ludics mag` JSON subcommand in `src/mag.ts` wiring harness paths to the
  classifier.
- USAGE registration in `src/index.ts` (+ lint parity).
- Minimal, prose-stable edit to `skills/ludics-health-check.md`
  §`check-outbound-staging-ff`.
- Unit tests for the three classifier branches + the boundary control.

Out of scope:
- Any change to the briefing-lag arm (already shipped in #557) or to the event
  emitter / classifier in `src/staging-ff.ts`.
- A precompute file / read-boundary for the health-check finding (seam (a),
  rejected).
- The operational fix for the live incident (restarting the controller /
  refreshing a token) — an operator action, not code.
