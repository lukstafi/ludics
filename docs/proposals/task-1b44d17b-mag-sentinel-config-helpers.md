# Consolidate mag.ts sentinel/config helpers

## Goal

Three bundled cleanups in `src/mag.ts` that landed as follow-ups from the
`gh-ludics-308` retrospective (grace-window fix, PR #341):

1. Collapse three near-identical config-reader functions into a single shared
   helper (pure DRY, no behavior change).
2. Export the production `clearStaleSettled()` with injectable time/grace so
   tests exercise the real code instead of a drifting local mirror.
3. Record the grace-window tradeoff in `docs/ARCHITECTURE.md` so a future
   "I typed into Mag right after settle and the next queue item still pasted
   on top of me" bug report is quick to diagnose.

Source: `gh-ludics-308` retrospective, items 1, 2, 4, 6.

## Acceptance Criteria

- A single helper in `src/mag.ts` (working name `magSecondsConfig`) encapsulates
  the "read `mag.<key>` from config, coerce with `Number(...)`, validate
  finite-and-positive, multiply by 1000, else default" shape.
- `stallThresholdMs()`, `stallNudgeCooldownMs()`, and `keepaliveIntervalMs()`
  each delegate to that helper. No change in behavior or config keys read —
  in particular `keepaliveIntervalMs` continues reading `mag.keepalive_interval`
  (not `_seconds`) because the key is shared with the launchd/systemd templates
  referenced by `src/triggers.ts`.
- `clearStaleSettled` is exported from `src/mag.ts` with an options parameter
  that accepts an injected `nowMs` (defaulting to `Date.now()`) and `graceMs`
  (defaulting to `keepaliveIntervalMs() * 1.5`). The production call site
  stays argument-free; only tests pass options.
- The local mirror `function clearStaleSettled(...)` inside the
  `describe("stale settled sentinel detection", ...)` block in
  `src/mag.test.ts` is deleted. The five tests originally calling the mirror
  (hash-changed, hash-unchanged, first-observation, no-sentinel, null-hash)
  now exercise the exported production function.
- The five grace-window regression tests in the same describe block (the ones
  already passing `{ nowMs }` / `{ nowMs, graceMs }`) continue to pass against
  the exported production function.
- `docs/ARCHITECTURE.md` contains a one-line (or one-bullet) note near the
  "Keepalive/nudge mechanism" bullet in the Mag lifecycle list (line 214 area)
  explaining that a genuinely-resumed pane within the ~90s grace window after
  settle cannot clear the sentinel.
- `bun test src/mag.test.ts` passes. Typecheck and lint pass.

## Context

### Item 1 — triplicated config readers

In `src/mag.ts`, three functions share an identical six-line body:

```ts
function stallThresholdMs(): number {
  const config = loadConfigSync();
  const mag = config.mag as Record<string, unknown> | undefined;
  const configured = Number(mag?.stall_threshold_seconds);
  if (Number.isFinite(configured) && configured > 0) return configured * 1000;
  return DEFAULT_STALL_THRESHOLD_MS;
}
```

The other two (`stallNudgeCooldownMs`, `keepaliveIntervalMs`) differ only in
the config key and the default constant. `keepaliveIntervalMs` uses
`mag.keepalive_interval` (no `_seconds` suffix) because that key is surfaced
by `src/triggers.ts` in the launchd/systemd template expansion.

### Item 2 — `clearStaleSettled` test mirror

The production `clearStaleSettled` in `src/mag.ts` (following
`isMagSettled()`) reads `Date.now()` and `keepaliveIntervalMs()` directly and
returns `void`. The `describe("stale settled sentinel detection", ...)` block
in `src/mag.test.ts` declares a local function of the same name that
reimplements the logic on a temp directory, returns `boolean`, and — since
PR #341 — the first five tests do not exercise the grace-window guard at all,
while five newer tests pass `{ nowMs, graceMs }` options to the mirror. The
mirror is a maintenance tax: production drift is silent.

`harnessDir()` (in `src/config.ts`) resolves via `LUDICS_HARNESS_DIR`, and
existing tests in `src/mag.test.ts` already set that env var for isolation
(see the blocks around line 260 and 403). The migrated tests can use the same
pattern: `process.env.LUDICS_HARNESS_DIR = tmpHarness;` in `beforeEach`, with
`mag/` as the state subdir. This removes the tmp-dir-is-not-the-state-dir
divergence in the mirror.

The codebase has no `__testing__` namespace precedent; the conventional
pattern (e.g. `maybeFeedMagQueue`) is plain `export function` with an
optional `@internal` JSDoc tag.

### Item 3 — architecture-doc anchor

`docs/ARCHITECTURE.md` line 214 sits inside the Mag lifecycle bullet list
under "How automation invokes Mag". The keepalive bullet is the natural
home for a short note about the grace window. The full rationale lives in
the `clearStaleSettled` JSDoc and in the landed proposal; the architecture
note only needs to surface the failure mode a user might observe.

### Out of scope

- Proposal Option 3 "two-phase hash" structural fix (retrospective item 3).
  Reviewer guidance: reactive only, deferred until another sentinel-timing
  bug surfaces.
- Any behavioral change to `on-stop`, `maybeFeedMagQueue`, or
  `maybeNudgeStalledMag`.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add `magSecondsConfig(key: string, defaultMs: number): number` near the
   existing `stallThresholdMs` / `keepaliveIntervalMs` block. Reduce each of
   the three existing functions to a one-line delegation.
2. Change `clearStaleSettled` to
   `export function clearStaleSettled(opts: { nowMs?: number; graceMs?: number } = {}): void`.
   Inside, compute `const nowMs = opts.nowMs ?? Date.now()` and
   `const graceMs = opts.graceMs ?? keepaliveIntervalMs() * 1.5`, then replace
   the two bare `Date.now()` / `keepaliveIntervalMs() * 1.5` uses. The
   existing zero-arg call in `magStart` (around line 2937) needs no change.
3. In `src/mag.test.ts`:
   - Import `clearStaleSettled` from `../src/mag.ts` (or the matching test
     import path).
   - Delete the local mirror.
   - In `beforeEach`, set `process.env.LUDICS_HARNESS_DIR` to a fresh tmp
     harness with a `mag/` subdir (mirroring the pattern already used
     elsewhere in the same file). Restore in `afterEach`.
   - Rewrite the ten tests to:
     - Write files into `join(tmpHarness, "mag", "settled")` and
       `join(tmpHarness, "mag", "last-pane.hash")` using the production paths.
     - Call `clearStaleSettled({ nowMs, graceMs })` and assert on side effects
       (file existence, file contents) rather than a returned boolean.
   - Where the current tests depend on `captureLastMessageHash()` reading a
     live tmux pane, either stub/mock that helper or seed the pre-state so
     the code path under test does not depend on tmux. (The mirror sidesteps
     this by taking `currentHash` as a parameter; the production function
     takes it from tmux — this is the main non-trivial migration step.)
4. Add one bullet or sub-bullet to `docs/ARCHITECTURE.md` ~line 214:
   > Genuine Mag activity within ~90s of settle cannot clear the sentinel
   > (grace window guards against the stop-hook's own text rendering into
   > the pane; see `clearStaleSettled` in `src/mag.ts`).

### Note on `captureLastMessageHash` dependency

`clearStaleSettled` calls `captureLastMessageHash(MAG_SESSION_NAME)`, which
shells out to tmux. The mirror avoided this by taking the hash as a
parameter. Three options for the migrated tests:

- **A.** Leave the `currentHash` parameter on the production function too:
  `clearStaleSettled({ nowMs?, graceMs?, currentHash?: string | null })`
  where `currentHash` defaults to `captureLastMessageHash(MAG_SESSION_NAME)`.
  Minimally invasive and parallels the `nowMs`/`graceMs` injection pattern.
  Recommended.
- **B.** Extract an internal `clearStaleSettledWithHash(hash, opts)` called
  by `clearStaleSettled()`; export only the extracted helper.
- **C.** Mock the tmux layer. Heavier for these specific tests.

Option A keeps the production call site zero-arg and the injection shape
uniform.

## Scope

**In:** `src/mag.ts`, `src/mag.test.ts`, `docs/ARCHITECTURE.md`.
Three files, no new abstractions beyond the one shared helper.

**Out:** `on-stop`, `maybeFeedMagQueue`, `maybeNudgeStalledMag`, two-phase
hash structural fix, any change to config key names or defaults.

**Dependencies:** none blocking. Relates to `gh-ludics-308` (parent, already
merged).
