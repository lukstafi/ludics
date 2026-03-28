# Proposal: Use Tailscale binding and local t3code-ludics build

**Task:** gh-ludics-47
**Effort:** medium
**Files changed:** 2 (`src/t3code/server.ts`, `src/t3code/server.test.ts`)

## Problem

The t3code adapter hardcodes `127.0.0.1` as the server host, uses `npx -y t3` as fallback (which runs upstream t3 instead of the ludics fork), and doesn't auto-generate auth tokens for non-localhost bindings.

## Changes in `server.ts`

### 1. Replace `DEFAULT_HOST` with `resolveHost()`

New exported function calls `networkHostname()` from `src/network.ts`. Maps `"localhost"` to `"127.0.0.1"`. In tailscale mode, returns the Tailnet hostname.

### 2. Update `ensureServer()`

- Calls `resolveHost()` for host
- Passes host to `findAvailablePort()` and `buildLaunchCommand()`
- Auto-generates a 24-byte hex auth token via `crypto.randomBytes` when binding to a non-localhost address and no `LUDICS_T3CODE_AUTH_TOKEN` env var is set
- Token persisted in `server.json` via `record.authToken`

### 3. Update `portAvailable()` and `findAvailablePort()`

Accept a `host` parameter instead of hardcoding `DEFAULT_HOST`.

### 4. Update `buildLaunchCommand()`

- Accepts optional `host` parameter, passes `--host` flag when set
- Prefers `~/t3code-ludics` over `~/t3code` for local source repo
- Uses `bun run --cwd <dir> start` instead of `bun --cwd <dir> src/index.ts`
- Local source repo checked before falling back to `t3` binary or `npx`

### 5. Update `commandLineMatchesServerRecord()`

Added recognition of `bun run` and `bun --cwd` patterns (additive, compatible with #45).

## Tests

3 new test cases in `server.test.ts`:
- `bun run --cwd` pattern matching
- `bun --cwd` (without run) matching
- Matching with a Tailscale hostname in the record

All tests pass.

## Notes

- `networkHostname()` already exists in `src/network.ts` (from gh-ludics-40 infrastructure)
- The `--host` flag is documented in `~/t3code-ludics/REMOTE.md`
- Auth token generation only triggers for non-localhost bindings (security measure)
