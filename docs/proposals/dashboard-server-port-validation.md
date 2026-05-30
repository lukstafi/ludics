# Validate the dashboard server port before binding (fixes `bun test` hang)

## Goal

Full `bun test` never completes on this host (Bun 1.3.11 / macOS) because
`scripts/dev-dashboard-mirror.test.ts > "removes mirror dir when server start
throws"` hangs forever. The test spawns the mirror with `--port 99999`
expecting `Bun.serve` to reject the out-of-TCP-range port. On Bun 1.3.11 /
macOS, `Bun.serve` instead *silently coerces* every invalid port to a
listenable one (`99999` → `65535`, `-1`/`NaN` → a random free port, `1.5` →
`1`), so the mirror process starts a real listener, parks on its
`SIGINT`/`SIGTERM` handlers, and the parent's `Bun.spawnSync` blocks with no
timeout (no `timeout(1)` binary exists on this macOS host to reap it). Every
coder since has had to fall back to `bun test src` for baselines, which
silently skips all of `scripts/` coverage.

This also fixes a real latent footgun in the production dashboard CLI: today
`startDashboardServer` listens on a port *different* from the one requested
whenever Bun coerces an out-of-range value, with no error.

Source: retrospective of `task-2c296dc0` (coder durable learning #2).

## Acceptance Criteria

- `startDashboardServer` (in `src/dashboard-server.ts`) validates the port
  *before* calling `Bun.serve` and throws for out-of-range / non-integer
  values. The rejection predicate is exactly
  `!Number.isInteger(port) || port < 0 || port > 65535`. `port === 0` remains
  valid (auto-select a free port). On a valid port the function behaves
  exactly as before.
- The thrown error is informative — it names the offending port value and the
  valid range — so the production CLI surfaces a clear failure instead of
  silently binding a coerced port.
- `scripts/dev-dashboard-mirror.ts` inherits the guard via its
  `startDashboardServer(port, …)` call inside the existing `try` block:
  `--port 99999` now reaches the `catch` block, which `rmSync`s the temp dir
  and re-`throw`s, so the process exits non-zero quickly with **no real
  listener bound**. No change to the script's control flow is required beyond
  what the inherited guard provides; the script must not be given a test-only
  hook or escape hatch.
- The `"removes mirror dir when server start throws"` test passes
  deterministically (process exits non-zero, no `ludics-dash-mirror-*` dir
  leaked under `/tmp`), without relying on OS / `Bun.serve` port-range
  rejection. The stale comment block above that test (currently asserting
  `"99999" is out of range for TCP … reaches startDashboardServer and
  throws`) is rewritten to describe the real mechanism: script-level /
  `startDashboardServer`-level port validation.
- Full `bun test` (not just `bun test src`) completes on Bun 1.3.11 / macOS
  with no infinite hang, and the suite is green (no new failures).
- No new flakiness or port collisions: the test does not depend on any
  specific port being free, and the existing `/tmp` leak assertion stays
  scoped to *newly*-leaked entries (the `before`-set subtraction is
  preserved — no regression).
- `port === 0` continues to start a server on an OS-selected free port
  (verified: the mirror's default `--port 0` path and the production CLI's
  configured-port path both still work).

## Context

How it works now:

- `src/dashboard-server.ts > startDashboardServer(port, dashboardDir,
  ttlSeconds)` wraps `Bun.serve({ port, fetch: buildHandlers(...) })` and
  performs **no** port validation of its own — it relies entirely on
  `Bun.serve`, which on this Bun/OS does not reject out-of-range or
  non-integer ports but coerces them. This is the single production entrypoint
  for the dashboard server; the production dashboard CLI and the dev mirror
  script both call it.
- `scripts/dev-dashboard-mirror.ts` parses `--port` (default `0`) via
  `parseNumberArg` (which only rejects non-finite `Number()` results, so
  `99999` passes), then inside a top-level `try { mkdirSync … cpSync …
  server = startDashboardServer(port, dashboardDir, ttl) } catch (err) {
  rmSync(root, { recursive: true, force: true }); throw err }`. The cleanup
  contract under test: *if the try-body throws before the signal handlers are
  registered, the temp dir is removed and the process exits non-zero.* The
  script has no exports — all logic is top-level — so this contract can only
  be exercised by spawning the script.
- `scripts/dev-dashboard-mirror.test.ts` — the hanging case is the
  `"dev-dashboard-mirror.ts startup-failure cleanup" > "removes mirror dir
  when server start throws"` test. It `Bun.spawnSync`s the script with
  `["--port", "99999"]`, asserts `proc.exitCode !== 0`, then asserts no new
  `ludics-dash-mirror-*` dir leaked under `/tmp` (via `before`-set
  subtraction). The comment block above it encodes the now-falsified
  assumption that `99999` is "out of range for TCP" and that `Bun.serve`
  rejects it.
- `scripts/lint-test-spawn-coverage.ts` — its recognizer fires only on test
  names matching `exits 0|1|N|non-zero`; this test's name does not match, so
  it is not policed by that lint. No change needed there.

Verification reachability: all paths named here live under
`git -C /Users/lukstafi/ludics` and are reachable from the project worktree;
no out-of-context paths are involved.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Add the guard at the top of `startDashboardServer`, before the `Bun.serve`
call, exactly as the resolved task questions specify (Approach C, guard in the
production entrypoint so both the CLI and the mirror script inherit it):

```ts
export function startDashboardServer(
  port: number,
  dashboardDir: string,
  ttlSeconds: number,
): ReturnType<typeof Bun.serve> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(
      `dashboard server port ${port} is invalid: expected an integer in [0, 65535] (0 auto-selects a free port)`,
    );
  }
  const server = Bun.serve({ … });
  …
}
```

Then rewrite the stale comment in
`scripts/dev-dashboard-mirror.test.ts` (lines describing the "out of range for
TCP" assumption) to state that `--port 99999` is now rejected by
`startDashboardServer`'s explicit range guard (not by `Bun.serve` / the OS),
which makes the `try`-body throw and the `catch`-block cleanup run. The test
body itself needs no change — `--port 99999` still produces a non-zero exit
and no leak — but confirm it stays green.

`port === 0` passes `Number.isInteger(0) && 0 >= 0 && 0 <= 65535`, so the
auto-select-free-port path is untouched.

## Scope

In scope:
- `src/dashboard-server.ts` — add the port-range guard to
  `startDashboardServer`.
- `scripts/dev-dashboard-mirror.test.ts` — rewrite the stale comment; verify
  the test passes.

Out of scope:
- Any change to `parseNumberArg` or the argv-validation tests (they already
  pass and cover non-finite input).
- Refactoring `scripts/dev-dashboard-mirror.ts` into an importable
  `main()`/`run()` (Approach D, rejected — heavier than `effort: small`).
- Any test-only env var / hidden-flag escape hatch in the script (Approach A,
  rejected — buys nothing once the real path throws).
- Changes to `scripts/lint-test-spawn-coverage.ts`.

Dependencies: relates to `task-2c296dc0` (the retrospective source); no
blocking dependencies.
