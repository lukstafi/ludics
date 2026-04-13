# Fix environment-dependent test failures: socket binding and port allocation

## Goal

Tests that bind network sockets fail intermittently on some machines (sandboxed CI,
reviewer environments) due to IPv6 binding, ephemeral port conflicts, or OS-level
socket restrictions. These failures waste review rounds and cause coder/reviewer
disagreements. The fix establishes a shared probe-and-skip pattern and hardens
production socket binding to prevent these issues.

Related: https://github.com/lukstafi/ludics/issues/198

## Acceptance Criteria

1. A shared `canBindSocket()` (or similar) test helper exists in a common location
   so any test file that needs network sockets can import and use it with
   `describe.if(canBind)(...)` instead of duplicating the probe logic.
2. The duplicated probe-and-skip blocks in `src/t3code/client.test.ts` and
   `src/t3code/cleanup.test.ts` are replaced with imports from the shared helper.
3. `src/dashboard-server.ts` specifies an explicit `hostname` (e.g. `"127.0.0.1"`)
   in its `Bun.serve()` call to avoid binding all interfaces including IPv6, which
   causes failures on systems without IPv6 loopback.
4. Testing conventions are documented (in `CLAUDE.md` or a dedicated testing guide)
   so future contributors know to use the shared helper for socket-binding tests.
5. All existing tests continue to pass.

## Context

### Current socket-binding test files

Only two test files bind real network sockets:

- **`src/t3code/client.test.ts`** (lines 17-27): probe-and-skip pattern using
  `Bun.serve({ hostname: "127.0.0.1", port: 0 })`, guarding tests with
  `describe.if(canBind)(...)`.
- **`src/t3code/cleanup.test.ts`** (lines 45-56): identical probe-and-skip pattern,
  copy-pasted.

All other test files use pure logic testing or mock transports.

### Production socket binding

- **`src/dashboard-server.ts`** (line 150): `Bun.serve({ port })` with NO
  `hostname` specified -- defaults to binding all interfaces including `::` (IPv6).
  This is the most likely source of cross-environment failures for the dashboard.
- **`src/t3code/server.ts`**: `findAvailablePort()` / `portAvailable()` using
  Node's `createServer()` on an explicit host (from `resolveHost()`, which returns
  `"127.0.0.1"` in localhost mode). This is already correctly parameterized.

### No existing shared test utilities

There is no `test-utils.ts` or shared test helper module in the codebase yet.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Create a shared test utility (e.g. `src/test-utils.ts`) exporting a `canBindSocket`
   boolean that runs the probe at import time.
2. Replace the duplicated probe blocks in both test files with an import.
3. Add `hostname: "127.0.0.1"` to the `Bun.serve()` call in `dashboard-server.ts`.
4. Add a brief testing conventions note to `CLAUDE.md` about using the shared helper.

## Scope

**In scope:**
- Shared test helper for socket-binding probe
- De-duplicating existing probe code in two test files
- Dashboard server hostname hardening
- Documentation of testing convention

**Out of scope:**
- CI configuration or shared CI baseline (no CI config exists in the repo; this is
  a separate concern)
- Changes to `portAvailable()` / `findAvailablePort()` in production code (already
  correctly parameterized)
