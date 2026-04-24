# Console capture/silence test helpers in `src/test-utils.ts`

## Goal

Replace ad-hoc `console.log` / `console.error` reassignment patterns scattered
across the test suite with a small family of named helpers in
`src/test-utils.ts`, then migrate the known inline call sites. This unifies the
try/finally restore plumbing, makes future regression tests for CLI dispatchers
a one-liner, and removes the easy-to-forget "did you restore on throw?" footgun.

Follow-up to PR #349 / gh-ludics-306 (which introduced `src/test-utils.ts` with
`canBindSocket` and `withTestHarness`). Source: retrospective of `task-da3cf294`.

## Acceptance Criteria

- `src/test-utils.ts` exports four new named helpers, each with a short JSDoc
  comment in the existing file's style:
  - `captureConsoleLog(fn: () => void): string[]` — runs `fn` with
    `console.log` swapped for a line collector, returns the collected lines.
  - `captureConsoleError(fn: () => void): string[]` — same shape for
    `console.error`.
  - `silenceConsoleError(fn: () => void): void` — runs `fn` with
    `console.error` no-op'd; no return value.
  - `silenceConsoleWarn(fn: () => void): void` — same shape for `console.warn`.
- All four helpers restore the original channel in `try/finally`, so a throw
  from `fn` still restores `console.*` before the exception propagates.
- The shared restore plumbing is factored — the four helpers must not be three
  to four near-duplicate try/finally bodies. Worker picks the factoring shape
  (suggestion below); review checks that there's a single internal primitive.
- Each capture helper records one line per `console.*` call. Arguments are
  stringified by `args.map((a) => String(a ?? "")).join(" ")` to match the
  existing inline pattern (and Node's default formatter for primitives).
- `src/test-utils.test.ts` is extended with coverage for all four new helpers:
  capture returns the lines and restores the channel; silence suppresses output
  and restores the channel; throw inside `fn` still restores the channel and
  propagates the exception.
- The following inline call sites are migrated to the new helpers:
  - `src/flow.test.ts` `describe("flowBlocked")` — both inline blocks (around
    lines 59-65 and 77-83) → `captureConsoleLog(() => flowBlocked(...))`.
  - `src/orchestration/worktrees.test.ts` — six inline `console.error` collector
    blocks (around lines 560, 747, 764, 790, 814, 844) → `captureConsoleError`.
  - `src/orchestration/skills.test.ts` — two inline `console.error` collector
    blocks (around lines 419 and 438) → `captureConsoleError`.
  - `src/dashboard.test.ts` — all 12 `console.error = () => {};` silencing
    sites (lines 241-565 range, identifiable by the `origErr` pattern) →
    `silenceConsoleError(() => ...)`.
- The following are explicitly NOT migrated:
  - `src/test-utils.ts` `void probe.stop(true);` — different purpose
    (floating-promises workaround, not a console capture).
  - `src/events.test.ts::captureOutput` — keeps its own async wrapper per user
    decision.
- Verification suite passes:
  `bun run typecheck && bun run lint && bun run build && bun test`.

## Context

`src/test-utils.ts` already exists with two named exports (`canBindSocket`,
`withTestHarness`) and a short-JSDoc, no-default-export style. New helpers slot
in alongside `withTestHarness`.

Inline patterns live today in five test files. There are three distinct shapes
(stringification differs slightly between sites; the helper unifies on the
multi-arg join that matches Node's default primitive formatter):

- **Log collector** — `src/flow.test.ts::describe("flowBlocked")` saves
  `console.log`, swaps in `(msg?: unknown) => lines.push(String(msg ?? ""))`,
  runs the unit, restores in `finally`. Two near-identical blocks.
- **Error collector** — `src/orchestration/worktrees.test.ts` and
  `src/orchestration/skills.test.ts` save `console.error`, swap in
  `(...args: unknown[]) => warnings.push(...)`, restore in `finally`.
  Eight blocks total (six in worktrees, two in skills).
- **Error silencer** — `src/dashboard.test.ts` saves `console.error`, swaps
  in `() => {}`, restores in `finally`. Twelve blocks (all use the same
  `const origErr = console.error;` / `console.error = () => {};` /
  `console.error = origErr` shape).

Bun's test runner runs tests serially by default, so global console mutation
is safe — same assumption the inline pattern already relies on.

`src/events.test.ts::captureOutput` is a near-twin async wrapper, deliberately
kept separate per Q1's resolution.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Factor the shared restore plumbing into a single internal primitive, then layer
the four public helpers on top:

```ts
type ConsoleChannel = "log" | "error" | "warn";

function withConsoleOverride(
  channel: ConsoleChannel,
  override: (...args: unknown[]) => void,
  fn: () => void,
): void {
  const orig = console[channel];
  console[channel] = override;
  try {
    fn();
  } finally {
    console[channel] = orig;
  }
}

function captureLines(channel: ConsoleChannel, fn: () => void): string[] {
  const lines: string[] = [];
  withConsoleOverride(channel, (...args: unknown[]) => {
    lines.push(args.map((a) => String(a ?? "")).join(" "));
  }, fn);
  return lines;
}

/** Capture lines written to `console.log` while running `fn`. */
export function captureConsoleLog(fn: () => void): string[] {
  return captureLines("log", fn);
}

/** Capture lines written to `console.error` while running `fn`. */
export function captureConsoleError(fn: () => void): string[] {
  return captureLines("error", fn);
}

/** Run `fn` with `console.error` no-op'd; restores on return or throw. */
export function silenceConsoleError(fn: () => void): void {
  withConsoleOverride("error", () => {}, fn);
}

/** Run `fn` with `console.warn` no-op'd; restores on return or throw. */
export function silenceConsoleWarn(fn: () => void): void {
  withConsoleOverride("warn", () => {}, fn);
}
```

`withConsoleOverride` is internal (not exported) — the four named helpers are
the public surface; review can object if a call site wants the primitive. The
factoring removes the four-way duplication of the try/finally body.

Migrations are mechanical:

```ts
// before
const lines: string[] = [];
const orig = console.log;
console.log = (msg?: unknown) => { lines.push(String(msg ?? "")); };
try {
  flowBlocked(...);
} finally {
  console.log = orig;
}

// after
const lines = captureConsoleLog(() => flowBlocked(...));
```

```ts
// before
const origErr = console.error;
console.error = () => {};
try {
  dashboardGenerate();
} finally {
  console.error = origErr;
}

// after
silenceConsoleError(() => dashboardGenerate());
```

For each migrated test file, add `captureConsoleLog` / `captureConsoleError` /
`silenceConsoleError` to the existing `./test-utils.ts` import (the migrated
files in `src/orchestration/` will need `../test-utils.ts`).

Note on stringification: existing `flow.test.ts` calls `console.log` with a
single arg, so `String(msg ?? "")` and the new `args.map(...).join(" ")` produce
identical output. Existing `worktrees.test.ts` uses `args.join(" ")` (no
`?? ""` guard) — the new helper's `String(a ?? "")` is a strict superset (an
explicit `null` becomes `""` instead of `"null"`), but no migrated assertion
depends on a literal `null` arg.

## Scope

In:
- Four new helpers in `src/test-utils.ts` plus shared internal primitive.
- Test coverage in `src/test-utils.test.ts`.
- Migration of the 22 inline call sites listed in Acceptance Criteria.

Out:
- `src/events.test.ts::captureOutput` (keeps its async wrapper).
- `src/test-utils.ts` `void probe.stop(true);` (different purpose).
- Any inline console-mutation call site not listed above (sweep is bounded to
  the four named files).
- Async variant / Promise-returning overload (Q1 resolved as sync-only).

Dependencies: relates to `task-da3cf294` (the retrospective source) but does
not block on it.
