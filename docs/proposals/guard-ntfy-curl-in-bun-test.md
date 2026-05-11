# Guard real ntfy.sh curl behind a test-mode check in `src/notify.ts`

## Goal

`bun test` currently issues real HTTPS POSTs to `https://ntfy.sh/<topic>` and
pages the user's phone. The user observed a real ntfy delivery on 2026-05-10
shaped `⚙️ Slot 11 [feat]: phase` / `Slot 11 [feat]: setup → done (round 1)`,
with **no matching entry** in the local `journal/notifications.jsonl` — the
title and body match the orchestration runner's phase-transition template,
seeded by the lifecycle test's `slot = 11` constant and `makeState`'s default
`taskId = "feat"`.

The elaboration in `tasks/task-87d4b17e.md` (Tentative Design section) traces
the leak: the unit test "reclaims stale tmux sibling lock when recorded PID is
dead" (`src/orchestration/runner.lifecycle.test.ts`, under the `gh-ludics-509`
block, around line 1443) mocks `phases.evaluateTransition → "done"` and runs
`runOrchestration` end-to-end. The runner reaches the phase-transition
`notifyAgents(..., \`${slotLabel}: phase\`)` call. `notifyAgents` → `notifySend`
in `src/notify.ts` has no test-mode guard. `loadConfigSync` /
`resolveConfigPath` in `src/config.ts` follow the harness's *real*
`config.yaml` pointer chain even when the test has overridden
`LUDICS_HARNESS_DIR` to a tmp directory, so `getTopic("agents")` returns the
real `lukstafi-agents` topic and `getToken()` returns the real bearer token —
the curl reaches `ntfy.sh` for real. The tmp `LUDICS_HARNESS_DIR` is removed
in `afterEach`, which is why the local journal has no record. The sibling
test on `slot = 12` (t3code variant) is the second confirmed leak site;
escalation tests on slots 11/12/13 in `runner.escalation.test.ts` mock
`notifyOutgoing` but not `notifyAgents`, so they are additional suspects.

The fix is a one-helper guard consulted by every curl-emitting site in
`src/notify.ts`, gated on `process.env.BUN_TEST` (set automatically by the Bun
test runner) with a belt-and-braces `process.env.NODE_ENV === "test"`. The
guard short-circuits the network call but preserves the local `notifyLog`
write, so test assertions that read `notifications.jsonl` keep working.

## Acceptance Criteria

- `src/notify.ts` exports an internal helper `shouldSuppressNtfy(): boolean`
  (or a same-shape private function — name not load-bearing) that returns
  `true` when **either** `process.env.BUN_TEST` is set to a truthy value
  (anything other than empty string or `"0"`) **or** `process.env.NODE_ENV ===
  "test"`. JSDoc on the helper cites this task ID and explains the two-env
  rationale (Bun-runner default + future-proofing).
- Every curl-emitting site in `src/notify.ts` consults the helper *after*
  `notifyLog` has recorded the message and *before* `safeSyncOutput` is
  called. The early return must NOT log a `console.error` (the guard is
  expected behaviour, not a failure). Sites to guard:
  - `notifySend` (used by `notifyOutgoing` and `notifyAgents`).
  - `notifyPublishMessage` (used by `notifyProposal` and
    `notifySessionConclusion`).
  - `notifyPublishFile` (used by `notifyProposal`'s file-attachment
    fallback).
  Concrete falsifier: `git -C ~/ludics grep -n 'safeSyncOutput\|fetch' src/notify.ts`
  reports four hits (the three guarded curl sites above and the SSE
  `fetch` in `subscribeIncoming`, which is unrelated — see Scope), and each
  of the three curl sites is preceded by a `shouldSuppressNtfy()` early
  return.
- `notifyPublishMessage` and `notifyPublishFile` return a synthesised
  `{ httpCode: "200", stderr: "", body: "" }` on the test-mode early return
  so that callers (`notifyProposal`, `notifySessionConclusion`) treat the
  call as successful and do not log the "HTTP code != 200" error path or
  trigger the file-attachment fallback inside the same test.
- `src/notify.test.ts` is extended with a positive-control test that
  invokes `notifySend` (or `notifyAgents`, whichever surface is most
  ergonomic) inside a `describe` block that sets `process.env.BUN_TEST =
  "1"` and asserts:
  1. `notifications.jsonl` in the test's tmp `LUDICS_HARNESS_DIR` contains
     one line matching the message.
  2. `safeSyncOutput` was NOT invoked. The cleanest probe is to `spyOn`
     `safeSyncOutput` from `./spawn.ts` (or mock the module) and assert
     `mock.calls.length === 0`. The test must restore the spy in
     `afterEach`.
  3. Mutation evidence: a one-line edit of the helper to return `false`
     unconditionally flips the new test PASS → FAIL. The PR comment / Notes
     section cites the diff that demonstrates this (suggested form below).
- A negative-control extension to the same test confirms the guard fires only
  for the test mode: with both `BUN_TEST` and `NODE_ENV` cleared inside an
  inner `try/finally`, the helper returns `false`. (Restoring the env vars
  immediately after the assertion is critical — otherwise the rest of the
  suite reaches real ntfy again.)
- The `runner.lifecycle.test.ts` cases on `slot = 11` (tmux) and `slot = 12`
  (t3code) still pass unchanged — the guard does not break their
  `runOrchestration` end-to-end path or their `journal/events.jsonl`
  assertions.
- The verification suite passes:
  `bun run typecheck && bun run lint && bun test`.
- Manual confirmation (recorded in PR notes, not a test assertion):
  subscribing to `https://ntfy.sh/lukstafi-agents` from another terminal
  while running `bun test src/orchestration/runner.lifecycle.test.ts`
  produces **no** "Slot 11 [feat]: phase" notification. Without this fix
  it reproduces deterministically.

## Context

`src/notify.ts` exposes three high-level emitters that wrap a curl to ntfy.sh:

- `notifySend(topic, message, priority, title, tags)` — the basic
  POST-message form used by `notifyOutgoing` and `notifyAgents`.
- `notifyPublishMessage(topic, message, token, title, priority, tags, actions)`
  — the rich form with actions, returning `{ httpCode, stderr, body }`. Used
  by `notifyProposal` and `notifySessionConclusion`.
- `notifyPublishFile(topic, filePath, filename, token, title, message, priority, tags, actions)`
  — the PUT-with-attachment fallback inside `notifyProposal` when the inline
  message form fails.

All three call `safeSyncOutput` with a `curl` argv constructed locally — there
is no central choke-point today. The proposed `shouldSuppressNtfy()` helper
becomes that choke-point. Every public emitter
(`notifyOutgoing` / `notifyAgents` / `notifyProposal` / `notifySessionConclusion`)
already calls `notifyLog` *before* the network call, so the local
`notifications.jsonl` write happens regardless of the guard — test assertions
that read the journal keep working unchanged.

The Bun test runner sets `process.env.BUN_TEST=1` automatically for the
duration of `bun test`. This is the canonical signal (Bun documents it as a
runtime invariant). `NODE_ENV === "test"` is added as belt-and-braces: the
project does not set it today, but a future migration off Bun's runner (or a
contributor running tests via a wrapper that does set `NODE_ENV`) keeps the
guard alive.

Key code pointers (by symbol, not line number, since line numbers drift):

- `notifySend`, `notifyPublishMessage`, `notifyPublishFile`,
  `notifyAgents`, `notifyOutgoing`, `notifyProposal`, `notifySessionConclusion`
  in `src/notify.ts`.
- `safeSyncOutput` in `src/spawn.ts` — the single underlying
  `Bun.spawnSync` wrapper that the guard's mutation-evidence test will
  spy on.
- The seed call sites that triggered the user's notification:
  `runner.lifecycle.test.ts` — the `slot = 11` (tmux) and `slot = 12`
  (t3code) "reclaims stale sibling lock when recorded PID is dead" tests
  under the `gh-ludics-509` block.
- `makeState` in `src/orchestration/runner.test-helpers.ts` — the
  default `taskId = "feat"` and default `slot = 1` constants that made
  the leak's title/body look like a real production notification.
- The phase-transition site in `src/orchestration/runner.ts` — search
  for the `slotLabel` literal and the `\`${slotLabel}: phase\`` title
  string passed to `notifyAgents`.

The SSE `fetch` call in `subscribeIncoming` (used by
`ludics notify subscribe`) is intentionally NOT guarded — that path is a
long-lived subscriber, not a test-driven emitter, and tests do not invoke it.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Add the helper near the top of `src/notify.ts`, just above `notifySend`:

```ts
/**
 * Return true when running under a test runner that should not actually
 * publish to ntfy.sh. Suppresses the network call but preserves the
 * upstream `notifyLog` write so test assertions on
 * `notifications.jsonl` keep working.
 *
 * See task-87d4b17e: without this guard, the lifecycle tests on
 * `slot = 11`/`12` reached `https://ntfy.sh/lukstafi-agents` for real
 * because `loadConfigSync` resolves the user's real config.yaml even
 * when `LUDICS_HARNESS_DIR` is a tmp directory.
 *
 * Two env vars: `BUN_TEST` (set by `bun test` automatically) is the
 * primary signal; `NODE_ENV === "test"` is belt-and-braces for any
 * future migration off the Bun runner or wrapper scripts that set
 * NODE_ENV explicitly.
 */
function shouldSuppressNtfy(): boolean {
  const bunTest = process.env.BUN_TEST;
  if (bunTest && bunTest !== "0") return true;
  if (process.env.NODE_ENV === "test") return true;
  return false;
}
```

In `notifySend`, return early before `safeSyncOutput` is called (do *not*
emit `console.error`):

```ts
function notifySend(topic: string, message: string, priority: number, title: string, tags: string): void {
  if (!topic) throw new Error("notify: topic required");
  if (!message) throw new Error("notify: message required");

  if (shouldSuppressNtfy()) return;

  const curlArgs = [
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    // ... existing argv construction ...
  ];
  // ... existing safeSyncOutput + httpCode check ...
}
```

In `notifyPublishMessage` and `notifyPublishFile`, return a synthesised
success record before constructing curl argv — this preserves the calling
contract for `notifyProposal` (which compares `result.httpCode !== "200"` to
decide whether to fall back to file attachment) and `notifySessionConclusion`
(which compares to decide whether to log success):

```ts
function notifyPublishMessage(/* ... */): { httpCode: string; stderr: string; body: string } {
  if (shouldSuppressNtfy()) return { httpCode: "200", stderr: "", body: "" };

  const curlArgs = [/* ... */];
  // ... rest unchanged ...
}
```

```ts
function notifyPublishFile(/* ... */): { httpCode: string; stderr: string; body: string } {
  if (shouldSuppressNtfy()) return { httpCode: "200", stderr: "", body: "" };

  const curlArgs = [/* ... */];
  // ... rest unchanged ...
}
```

The test additions in `src/notify.test.ts` follow the existing
`describe("notify state-file atomic writes", ...)` block's `tmpdir +
LUDICS_HARNESS_DIR` pattern. Suggested shape:

```ts
import { spyOn } from "bun:test";
import * as spawnModule from "./spawn.ts";

describe("notify ntfy.sh suppression under bun test", () => {
  let tmpDir: string;
  const ORIGINAL_HARNESS_DIR = process.env.LUDICS_HARNESS_DIR;
  const ORIGINAL_BUN_TEST = process.env.BUN_TEST;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ludics-notify-suppress-"));
    mkdirSync(join(tmpDir, "journal"), { recursive: true });
    process.env.LUDICS_HARNESS_DIR = tmpDir;
    // BUN_TEST is already set by the runner; assert that, not override.
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
    if (ORIGINAL_BUN_TEST === undefined) delete process.env.BUN_TEST;
    else process.env.BUN_TEST = ORIGINAL_BUN_TEST;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  test("notifyAgents writes to journal but does NOT invoke safeSyncOutput under BUN_TEST", async () => {
    // Sanity: the runner sets this for us.
    expect(process.env.BUN_TEST).toBeTruthy();

    const spawnSpy = spyOn(spawnModule, "safeSyncOutput");
    const { notifyAgents } = await import("./notify.ts");
    try {
      notifyAgents("suppression-probe-message", 1, "suppression-probe-title");
      expect(spawnSpy.mock.calls.length).toBe(0);
      const log = readFileSync(join(tmpDir, "journal", "notifications.jsonl"), "utf-8");
      expect(log).toContain("suppression-probe-message");
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
```

(The agent may need to adapt the `spyOn` call shape depending on how
`safeSyncOutput` is imported into `notify.ts` — if static `import { ... } from "./spawn.ts"` resolves to the same module object the spy targets, this works
directly. If not, switch to `mock.module("./spawn.ts", ...)`. Bun's
`spyOn(module, "export")` works when the importer uses
`import * as` or the module re-exports through a getter; if the existing
static import shape blocks it, an `import * as spawn from "./spawn.ts"`
refactor inside `notify.ts` is in scope.)

Mutation-evidence diff (cite in PR notes — *do not* commit):

```diff
 function shouldSuppressNtfy(): boolean {
-  const bunTest = process.env.BUN_TEST;
-  if (bunTest && bunTest !== "0") return true;
-  if (process.env.NODE_ENV === "test") return true;
-  return false;
+  return false;
 }
```

Run `bun test src/notify.test.ts` against that diff — the new
suppression test must fail (spy sees a call, or the curl runs for real).
Restore the helper and verify the test passes. This is the
`stash-prod mutation test` falsifier from the AC rigor reference.

## Scope

In:

- The `shouldSuppressNtfy()` helper in `src/notify.ts`.
- Guards inside `notifySend`, `notifyPublishMessage`, `notifyPublishFile`
  (three call sites — the only three curl emitters in the file).
- One new positive-control test (and its negative-control counterpart) in
  `src/notify.test.ts`, plus the env-var save/restore plumbing in
  `beforeEach` / `afterEach`.

Out:

- Changing `makeState`'s default `taskId = "feat"` in
  `src/orchestration/runner.test-helpers.ts`. The elaboration noted this as
  optional polish ("a more obviously-test value like `__test__` would make
  future leaks easier to triage"). Treat as a follow-up task only if cheap;
  the guard renders the cosmetic landmine non-load-bearing.
- Removing the `feature` ↔ `taskId` backwards-compat shim in
  `src/adapters/peer-sync.ts` / `src/orchestration/state.ts`. Out of scope
  per the task file's existing Out-of-scope note; the shim is unrelated to
  this bug.
- Re-architecting `loadConfigSync` / `resolveConfigPath` in
  `src/config.ts` to honour `LUDICS_HARNESS_DIR` for the config-pointer
  chain. That would be a much larger change with separate consequences
  (tests would lose access to real `adapter` / `slots.count` settings). The
  targeted ntfy guard fixes this leak class without that surgery.
- Guarding the SSE `fetch` call in `subscribeIncoming` — that path is not
  test-reachable, and the guard would block the production subscriber.
- Adding a "did the suite emit any real ntfy curl?" CI assertion. Worth
  filing separately if a regression of this shape is suspected later;
  out of scope for this fix.

Dependencies: none. This is a self-contained mechanical fix in one source
file plus one test file.
