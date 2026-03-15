# Proposal: Fix PID check false negative for npm-wrapped server process

**Task:** gh-ludics-45
**Effort:** medium
**Files changed:** 2 (`src/t3code/server.ts`, `src/t3code/server.test.ts`)

## Problem

When the t3code server is launched via `npm exec`, `bun run`, or similar wrappers, the recorded PID belongs to the wrapper process, not the `t3` binary. `commandLineMatchesServerRecord()` fails to match the wrapper's command line, so `serverStatus()` returns `reason: "pid reused by another process"` even though the server is running fine on its port.

## Change 1: Broaden `commandLineMatchesServerRecord()` (belt-and-suspenders)

**File:** `src/t3code/server.ts`, lines 226-238

Current function checks for `t3 `, `/t3 `, `npx `, ` npx `, ` src/index.ts`, and ` dist/index.mjs`. Add patterns for `npm exec`, `bun run`, and `bun --cwd` wrappers:

```typescript
export function commandLineMatchesServerRecord(
  commandLine: string | null,
  record: T3CodeServerRecord,
): boolean {
  if (!commandLine) return false;
  if (!commandLine.includes(record.stateDir)) return false;
  return commandLine.startsWith("t3 ")
    || commandLine.includes("/t3 ")
    || commandLine.startsWith("npx ")
    || commandLine.includes(" npx ")
    || commandLine.startsWith("npm ")
    || commandLine.includes(" npm ")
    || commandLine.startsWith("bun ")
    || commandLine.includes(" bun ")
    || commandLine.includes(" src/index.ts")
    || commandLine.includes(" dist/index.mjs");
}
```

The `record.stateDir` check is the real identity anchor -- it ensures the process was launched with the same state directory. The binary-name checks are a secondary sanity filter.

## Change 2: HTTP health check fallback in `serverStatus()`

**File:** `src/t3code/server.ts`, lines 85-87

When the PID is alive but command-line matching fails, try an HTTP GET to the server's `webUrl` with a 2-second timeout before declaring "pid reused":

```typescript
  if (!inspection.matchesRecord) {
    // HTTP fallback: the PID may be a wrapper process whose command line
    // doesn't match our patterns, but the server is actually running.
    try {
      const resp = await fetch(record.webUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        // Server is responding — fall through to the WebSocket snapshot check below.
      } else {
        return { running: false, record, snapshot: null, reason: "pid reused by another process" };
      }
    } catch {
      return { running: false, record, snapshot: null, reason: "pid reused by another process" };
    }
  }
```

The 2-second timeout is short enough to avoid stalling normal operations. Only triggers in the mismatch case (not the happy path).

## Change 3: Update tests

**File:** `src/t3code/server.test.ts`

Add test cases for new wrapper patterns:
- `npm exec t3 -- --mode desktop --port 3773 --state-dir ... --no-browser` => true
- `bun run t3 --mode desktop --port 3773 --state-dir ... --no-browser` => true

## Scope and risk

- **Minimal footprint**: Two functions touched in `server.ts`, plus new test cases. No changes to `types.ts`, `client.ts`, or `t3code.ts`.
- **No behavioral change for the happy path**: When the PID's command line matches, the HTTP fallback is never reached.
- **Safe for sibling PRs**: #46 and #47 touch different parts of `server.ts`. The only shared surface is `commandLineMatchesServerRecord`, which they don't modify.
- **`fetch()` availability**: Bun has native `fetch` and `AbortSignal.timeout` -- no new dependencies needed.

## Not included

- No changes to `stopServer()` or `ensureServer()` -- the fix propagates through `serverStatus()`.
- No changes to `buildLaunchCommand()` -- that's #47's scope.
