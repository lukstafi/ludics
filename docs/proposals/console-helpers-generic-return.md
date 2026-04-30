# Generic-typed console capture/silence helpers

## Goal

Refine the four exported console helpers in `src/test-utils.ts`
(`captureConsoleLog`, `captureConsoleError`, `silenceConsoleError`,
`silenceConsoleWarn`) to be generic over `T` and return `fn`'s value, and add
a forward-pointing TODO at `src/events.test.ts::captureOutput` for the day its
async wrapper can collapse to `captureConsoleLog`.

Source: retrospective of `task-95310454`'s `suggestRefactorSummary`. Two
loosely-coupled refinements, both small.

**Note on motivation drift.** The original task body named one concrete
return-needing call site — `startDashboardServer` in `src/dashboard.test.ts`,
which used a `let server!: T; silenceConsoleError(() => { server = ...; })`
dance. That site was eliminated by `task-bf451303` (commit `eeca60d`,
`buildHandlers(deps)` factory extraction); dashboard tests now construct
handlers directly without ever calling `startDashboardServer` from test code.
No remaining caller in the tree needs the new return type today. The value
proposition is therefore (a) a symmetric helper API for future return-needing
wrappers and (b) unblocking items 3 and 4 (TODO comment + new tests), which are
pure additions. Confidence is medium because the value-vs-churn ratio shifted —
the capture-variant change is a breaking type change at 13 consumer sites
inside this repo, against zero callers that use the new return today.

## Acceptance Criteria

- **AC1 — Helper signatures changed.** The four exports in `src/test-utils.ts`
  are generic over `T` and return `fn`'s value:
  - `captureConsoleLog<T>(fn: () => T): { lines: string[]; value: T }`
  - `captureConsoleError<T>(fn: () => T): { lines: string[]; value: T }`
  - `silenceConsoleError<T>(fn: () => T): T`
  - `silenceConsoleWarn<T>(fn: () => T): T`
  The private `withConsoleOverride` and `captureLines` primitives are updated
  in lockstep. `bun run typecheck` passes after the refactor + consumer-site
  migration.

- **AC2 — Capture variants preserve `fn`'s return value.** `src/test-utils.test.ts`
  has at least one new test per capture variant that captures from a function
  returning a non-void value (e.g. `T = number` or `T = string`) and asserts
  both `lines` and `value`. Falsifier: a hypothetical mutation that drops
  `value` from the returned shape (or swaps `value` for `undefined`) must fail
  one of these tests.

- **AC3 — Silence variants preserve `fn`'s return value.** `src/test-utils.test.ts`
  has at least one new test per silence variant that runs a function returning
  a non-void value and asserts the helper's return is that value. Falsifier:
  a mutation that returns `undefined` instead of `fn`'s value must fail.

- **AC4 — Backward compatibility at void call sites.** All existing
  `silenceConsoleError(() => stmt)` / `silenceConsoleWarn(() => stmt)` /
  `silenceConsole*(() => { ...stmts })` call sites compile unchanged (TS
  infers `T = void`). The 19 silence-variant consumer sites in
  `src/orchestration/`, `src/dashboard.test.ts`, etc. are not edited as part
  of this task. `bun run typecheck` confirms.

- **AC5 — TODO comment present.** `src/events.test.ts` carries a
  `// TODO(once-import-is-static): replace with captureConsoleLog` (or
  equivalent wording) attached to `captureOutput`. The site is the
  `async function captureOutput(args: string[]): Promise<string[]>` inside
  `describe("eventsQuery validation", ...)`.

- **AC6 — Capture-variant consumer sites migrated.** The 13 capture-variant
  call sites outside `test-utils.test.ts` are updated to destructure `lines`
  from the new return shape (e.g.
  `const { lines } = captureConsoleError(() => ...);` or
  `.lines.length`). Specifically:
  - `src/flow.test.ts` lines ~59 and ~70 (two sites, both `captureConsoleLog`).
  - `src/orchestration/skills.test.ts` lines ~441 and ~459 (two sites).
  - `src/orchestration/worktrees.test.ts` lines ~561, 740, 752, 773, 792, 818,
    1023, 1053, 1072 (nine sites).
  - The pre-existing `test-utils.test.ts` capture-variant tests are also
    updated to the new shape as part of the refactor.
  Line numbers are approximate (drift); the consumer-site set is identified
  by `grep -rn 'captureConsoleLog\|captureConsoleError' src/ --include='*.ts'`.

- **AC7 — Verification suite passes.**
  `bun run typecheck && bun run lint && bun run build && bun test` clean.

## Context

`src/test-utils.ts` currently defines:

```ts
type ConsoleChannel = "log" | "error" | "warn";

function withConsoleOverride(
  channel: ConsoleChannel,
  override: (...args: unknown[]) => void,
  fn: () => void,
): void { /* try/finally restore */ }

function captureLines(channel: ConsoleChannel, fn: () => void): string[] {
  const lines: string[] = [];
  withConsoleOverride(channel, (...args) => {
    lines.push(args.map((a) => String(a ?? "")).join(" "));
  }, fn);
  return lines;
}

export function captureConsoleLog(fn: () => void): string[] { ... }
export function captureConsoleError(fn: () => void): string[] { ... }
export function silenceConsoleError(fn: () => void): void { ... }
export function silenceConsoleWarn(fn: () => void): void { ... }
```

`src/events.test.ts::captureOutput` is the long-lived async twin:

```ts
async function captureOutput(args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    const { runEvents } = await import("./events.ts");
    runEvents(args);
  } finally {
    console.log = origLog;
  }
  return lines;
}
```

It cannot collapse to `captureConsoleLog<T>` today because the wrapper is
`async` solely so it can `await import()`. When that dynamic import is
later switched to a static top-level import, `captureOutput` reduces to a
one-liner over `captureConsoleLog`. The TODO marks that dependency.

`src/test-utils.test.ts` already has `describe("captureConsoleLog", ...)`,
`describe("captureConsoleError", ...)`, and silence-variant tests; new
return-value cases extend these existing blocks.

### Capture-variant consumer site survey

13 capture-variant call sites in production test files (excluding
`test-utils.test.ts`):

- `src/flow.test.ts:59` — `const lines = captureConsoleLog(() => flowBlocked());` then `lines.map(...)`
- `src/flow.test.ts:70` — same shape
- `src/orchestration/skills.test.ts:441` — `const warnings = captureConsoleError(...)`; reads `warnings.length` / `warnings[0]`
- `src/orchestration/skills.test.ts:459` — same shape
- `src/orchestration/worktrees.test.ts:561,740,752,773,792,818,1023,1053,1072` — nine sites, all `const warnings = captureConsoleError(...)` then `.length`/`.map`/index reads.

All 13 are mechanical destructure changes (`const lines = ...` →
`const { lines } = ...`, `const warnings = ...` →
`const { lines: warnings } = ...`). No logic changes.

### Silence-variant consumer site survey

19 silence-variant call sites (`src/dashboard.test.ts`, `src/orchestration/`,
elsewhere). All pass void-returning lambdas; TS infers `T = void`, the
return value is discarded, no caller edits required (AC4).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

```ts
type ConsoleChannel = "log" | "error" | "warn";

function withConsoleOverride<T>(
  channel: ConsoleChannel,
  override: (...args: unknown[]) => void,
  fn: () => T,
): T {
  const orig = console[channel];
  console[channel] = override;
  try {
    return fn();
  } finally {
    console[channel] = orig;
  }
}

function captureLines<T>(
  channel: ConsoleChannel,
  fn: () => T,
): { lines: string[]; value: T } {
  const lines: string[] = [];
  const value = withConsoleOverride(channel, (...args) => {
    lines.push(args.map((a) => String(a ?? "")).join(" "));
  }, fn);
  return { lines, value };
}

export function captureConsoleLog<T>(fn: () => T): { lines: string[]; value: T } {
  return captureLines("log", fn);
}
export function captureConsoleError<T>(fn: () => T): { lines: string[]; value: T } {
  return captureLines("error", fn);
}
export function silenceConsoleError<T>(fn: () => T): T {
  return withConsoleOverride("error", () => {}, fn);
}
export function silenceConsoleWarn<T>(fn: () => T): T {
  return withConsoleOverride("warn", () => {}, fn);
}
```

Consumer-site migration is a one-line destructure per site; e.g.

```ts
// before
const lines = captureConsoleLog(() => flowBlocked());
// after
const { lines } = captureConsoleLog(() => flowBlocked());

// before
const warnings = captureConsoleError(() => ensureGitExcludes(repo));
// after
const { lines: warnings } = captureConsoleError(() => ensureGitExcludes(repo));
```

TODO insertion at `src/events.test.ts::captureOutput`:

```ts
// TODO(once-import-is-static): replace with captureConsoleLog from ./test-utils.ts
async function captureOutput(args: string[]): Promise<string[]> {
  ...
}
```

## Scope

In:
- Refactor `withConsoleOverride`, `captureLines`, and the four exports in
  `src/test-utils.ts` to be generic over `T`.
- Add return-value tests for each variant (covering `T = void` and
  `T = <concrete>`) to `src/test-utils.test.ts`; update the existing
  `captureConsole*` tests there to the new return shape.
- Migrate the 13 capture-variant consumer sites in `src/flow.test.ts`,
  `src/orchestration/skills.test.ts`, `src/orchestration/worktrees.test.ts`.
- Add the TODO comment at `src/events.test.ts::captureOutput`.

Out:
- Migrating `captureOutput` itself — gated on the upstream dynamic-import
  being made static, separate refactor. The TODO comment is the only edit
  to `src/events.test.ts`.
- Editing the 19 silence-variant consumer sites — they remain unchanged
  (TS infers `T = void`, return discarded).
- Extracting common patterns or normalising call shapes — the migration is
  intentionally a mechanical one-line destructure per site, no factoring of
  shared post-capture logic.
- Async / Promise-returning helper variants.

Dependencies: relates to `task-95310454` (the source retrospective) and
`task-bf451303` (which eliminated the original named migration target).
