# Rename `sleep(ms)` to `sleepMs` and consolidate the three definitions

## Goal

Encode the time unit in the name of the project's sleep helper so every call
site reads as unambiguously millisecond-scaled. `sleep(0.2)` (a near-miss 200 µs
busy-spin caught pre-commit in task-72a318c3) would read as `sleepMs(0.2)` —
visibly wrong at the point of use. Additionally, consolidate three identical
file-private definitions into the single already-exported helper in
`src/orchestration/util.ts`.

This applies the reference-layer-not-inline principle: put the invariant (unit)
in the API shape rather than in per-call-site mental checks or comments.

Source: retrospective of `task-72a318c3` (coder's `suggestRefactorSummary`
item 5).

## Acceptance Criteria

- The helper is named `sleepMs` in its definition at `src/orchestration/util.ts`,
  with the unchanged signature `(ms: number): Promise<void>` and unchanged body.
- The file-private `sleep` definitions in `src/t3code/client.ts` and
  `src/t3code/server.ts` are removed; both files consume `sleepMs` imported
  from `../orchestration/util.ts`.
- All 9 project-`sleep` call sites are renamed to `sleepMs`:
  - `src/orchestration/runner.ts` — 4 sites (one in a `Promise.race`, one
    `sleep(200)`, two `sleep(state.config.pollInterval * 1000)`).
  - `src/t3code/client.ts` — 1 site (`sleep(options.pollIntervalMs)`).
  - `src/t3code/server.ts` — 4 sites (`sleep(1_000)` x2, `sleep(100)`,
    `sleep(200)`).
- The two `runner.ts` sites that scale seconds→ms (`state.config.pollInterval
  * 1000`) retain their `* 1000` after the rename — `pollInterval` is in
  seconds, `sleepMs` takes milliseconds, so the conversion is still correct.
- `Bun.sleep(...)` call sites are not touched (different symbol, out of scope).
- `"sleep"` and `'sleep'` string literals used to spawn the Unix `sleep`
  binary (e.g. `src/mag.ts`, `src/spawn.test.ts`, `src/slots/slot-clear-integration.test.ts`)
  are not touched.
- `bun run typecheck`, `bun run build`, and `bun test` all pass. Runtime
  behavior is unchanged (pure rename + dedup).

## Context

### Existing definitions (three, all structurally identical)

All three have the body `return new Promise((resolve) => setTimeout(resolve, ms));`
and signature `(ms: number): Promise<void>`:

- `src/orchestration/util.ts` — exported `sleep`, the intended single host.
- `src/t3code/client.ts` — file-private duplicate, near the top under "Internal
  helpers".
- `src/t3code/server.ts` — file-private duplicate, near the bottom of the file
  next to the private `isoNow` helper.

### Existing imports

- `src/orchestration/runner.ts` imports from `./util.ts`:
  `import { isoNow, makeId, nowEpoch, sleep } from "./util.ts";` — rename the
  imported name.
- `src/t3code/server.ts` already imports `setsidWrap` from
  `../orchestration/util.ts` — extend that import to also pull in `sleepMs`,
  then delete the local definition.
- `src/t3code/client.ts` has no import from `../orchestration/util.ts` today —
  a new `import { sleepMs } from "../orchestration/util.ts";` line is needed.
  (This import direction — `t3code/` → `orchestration/util` — is already
  established by `server.ts` and by `src/adapters/t3code.ts`, so it is not a
  new layering concern.)

### Call-site inventory (9 total)

- `src/orchestration/runner.ts`: 4 sites — inside the adapter-race helper
  (`sleep(interval)` in a `Promise.race`), a `sleep(200)` backoff, and two
  `sleep(state.config.pollInterval * 1000)` loop ticks.
- `src/t3code/client.ts`: 1 site — `await sleep(options.pollIntervalMs);`
  in the polling loop.
- `src/t3code/server.ts`: 4 sites — `sleep(1_000)` x2 (reconnect backoff),
  `sleep(100)`, `sleep(200)`.

### What is *not* in scope (verified during elaboration)

- `Bun.sleep(...)` (11 sites in `notify.ts`, `adapters/tmux-adapter.ts`,
  `orchestration/process.ts`, `orchestration/transport-tmux.ts`,
  `slots/index.ts`) — different symbol, unrelated to the project helper.
- Shell `sleep` invocations — `safeSyncOutput(["sleep", "0.5"])` in `mag.ts`,
  and the `/bin/sleep` binary spawned in tests.
- `src/orchestration/transport-tmux.test.ts` — spies on `Bun.sleep`, not the
  project helper.
- No test file defines or imports the project `sleep` helper.
- `sleepMs` does not currently exist anywhere in the codebase — no collision.

### Why a helper rename, not a lint rule or comment

- A lint rule flagging `sleep(<small-literal>)` would be noisy and trivially
  bypassable.
- Per-call-site comments add template bloat (cf. reference-layer-not-inline).
- A unit-named helper fixes the ambiguity structurally at the one shared API
  surface.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Because the change is mechanical, a single pass is sufficient:

1. In `src/orchestration/util.ts`, rename `export function sleep` →
   `export function sleepMs`. Body unchanged.
2. In `src/orchestration/runner.ts`, change the import from `sleep` to
   `sleepMs` and rename all 4 call sites. Keep the `* 1000` in the two
   `pollInterval` call sites.
3. In `src/t3code/server.ts`, extend the existing `setsidWrap` import to
   `import { setsidWrap, sleepMs } from "../orchestration/util.ts";`, delete
   the file-private `sleep` definition near line 956, and rename all 4 call
   sites.
4. In `src/t3code/client.ts`, add
   `import { sleepMs } from "../orchestration/util.ts";`, delete the
   file-private `sleep` definition (around line 19), and rename the single
   call site at line 323.
5. Run `bun run typecheck`, `bun run build`, and `bun test` to confirm
   no regression.

## Scope

**In scope:** the rename and consolidation described above.

**Out of scope (deliberate, per task):**

- Introducing a `sleepSec` companion. The original retrospective suggestion
  floated `sleepMs` / `sleepSec` as a pair, but the only observed failure
  mode so far is `ms`-unit ambiguity. Introducing `sleepSec` would also
  invite collapsing `sleepMs(state.config.pollInterval * 1000)` →
  `sleepSec(state.config.pollInterval)`, which is a semantic-adjacent refactor
  better left until the mixed-unit pattern appears in practice.
- Any timing-logic changes.
- Touching `Bun.sleep` call sites.
- Deduplicating the adjacent private `isoNow` helper in `server.ts` (which
  also shadows an export from `util.ts`). Noted as a natural follow-up; left
  out to keep this task focused.

**Dependencies:** none. Relates to `task-72a318c3` (the source retrospective).
