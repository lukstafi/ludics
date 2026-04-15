# Proposal: Inline networkMode() and replace redundant `which tailscale` check

**Task:** task-8d1dc3b0
**Date:** 2026-04-15

## Goal

Remove two minor inefficiencies in `src/network.ts`:

1. **`networkMode()` is an unnecessary indirection** -- it's an exported function that only reads `config.cluster?.transport ?? "localhost"`, has no external callers (used only at lines 44 and 72 within `network.ts`), and its export forces tests to spy on it instead of mocking config. Inlining it reduces surface area and simplifies tests.

2. **`networkStatus()` runs a redundant `which tailscale` subprocess** (line 78) that duplicates work already done by `findTailscaleCli()`, which is strictly better (also checks the macOS app bundle fallback path). Replacing the subprocess call with `findTailscaleCli()` eliminates one process spawn and fixes a correctness gap where the macOS-only CLI path would be missed.

These are the remaining two actionable items from the retrospective of task-2086a0ad. Item 1 (convert dynamic `require("./cluster.ts")` to static import) was dropped during elaboration because the circular dependency `network.ts -> cluster.ts -> network.ts` is still active and the dynamic require is intentional.

## Acceptance Criteria

1. `networkMode()` is removed from `src/network.ts` -- no function definition, no export.
2. Both call sites (in `networkHostname()` and `networkStatus()`) read the transport mode inline via `loadConfigSync().cluster?.transport ?? "localhost"`.
3. `findTailscaleCli()` is exported from `src/network.ts`.
4. The `which tailscale` subprocess call in `networkStatus()` (line 78) is replaced with `findTailscaleCli() !== null`.
5. All three tests in `src/network.test.ts` that spy on `networkMode` are updated to mock `loadConfigSync` instead (or use another config-level mock strategy).
6. `bun run build` succeeds with no type errors.
7. `bun test src/network.test.ts` passes.
8. No other files need changes (confirmed: `networkMode` has zero external callers).

## Context

- **File**: `src/network.ts` (108 lines)
- **Test file**: `src/network.test.ts` (55 lines)
- **`networkMode()`** defined at line 6, called at lines 44 and 72
- **`findTailscaleCli()`** defined at line 11 (currently not exported), called by `hostnameTailscale()` at line 21
- **Redundant subprocess**: line 78 `safeSyncOutput(["which", "tailscale"]).ok`
- **Tests spying on `networkMode`**: lines 8, 26, 39 of `network.test.ts`
- **Prior related work**: gh-ludics-258 (removed `network.mode` fallback from `networkMode()`), task-9eb72980 (removed compat shim from `cluster.ts`), task-2086a0ad (network config removal -- source of this cleanup)

## Approach

### Step 1: Inline `networkMode()` into its two call sites

Replace each `networkMode()` call with:
```typescript
const mode = loadConfigSync().cluster?.transport ?? "localhost";
```

Then delete the `networkMode()` function definition and its export.

### Step 2: Export `findTailscaleCli()` and replace `which tailscale` subprocess

Change `function findTailscaleCli()` to `export function findTailscaleCli()`.

In `networkStatus()`, replace:
```typescript
const hasTailscale = safeSyncOutput(["which", "tailscale"]).ok;
```
with:
```typescript
const hasTailscale = findTailscaleCli() !== null;
```

### Step 3: Update tests

The three tests that spy on `networkMode` need restructuring. Two strategies:

**Option A (preferred)**: Mock `loadConfigSync` to return a config object with the desired `cluster.transport` value. This tests the actual inlined logic.

**Option B**: Create a test helper that sets config state. This is more involved and not warranted for 3 tests.

For each test:
- Replace `spyOn(network, "networkMode").mockReturnValue("localhost")` with a mock of `loadConfigSync` that returns `{ cluster: { transport: "localhost" } }` (or no cluster key for localhost default).
- The `networkStatus` test already mocks `hostnameTailscale` -- keep that, just change the config mock.

Since the test file imports `* as network`, and `loadConfigSync` is imported from `./config.ts`, the mock will need to use `spyOn` on the config module or use `mock.module`. The exact approach depends on Bun's test mock capabilities -- the agent should verify which pattern works.

### Step 4: Verify

Run `bun run build` and `bun test src/network.test.ts` to confirm everything works.
