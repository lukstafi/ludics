# slotAssign defaults machine to a real node in federated setups

## Goal

When `ludics slot N assign` is invoked without `--machine` in a federated
setup (`cluster.machines` configured in `config.yaml`), `slot-N.json` is
written with `"machine": null`. The dashboard's `generateTerminals()` and
`lookupSlotOrchestrationLinks()` both require a non-null machine name to
build ttyd URLs, so the slot tile and Terminals tab silently lose their
links despite tmux/ttyd being healthy. This was hit during the
gh-ludics-376 manual-assignment incident (2026-04-24); the user had to
hand-edit `slots/slot-1.json` to recover dashboard visibility.

The fix: default the machine field to a real node name (current host, or
leader as a fallback) when cluster is enabled, while preserving today's
single-machine behaviour (`null`) when cluster is not configured.

## Acceptance Criteria

- **Federated, no `--machine`, current host is in `cluster.machines`** →
  slot data records the current machine's name (from
  `clusterCurrentMachineName()`).
- **Federated, no `--machine`, current host is NOT in `cluster.machines`,
  but a leader exists** → slot data records the leader's name (from
  `resolveController()`), and a one-line warning is printed to stderr
  identifying the fallback.
- **Federated, no `--machine`, no resolvable self and no leader** →
  slot data records `null` (preserves today's behaviour for genuinely
  un-resolvable cases) and a stderr warning surfaces the reason.
- **Non-federated (`cluster.machines` absent or `transport === "local"`)**
  → slot data records `null`. Back-compat with single-machine setups is
  preserved exactly.
- **Explicit `--machine <name>`** → unchanged; the CLI arg short-circuits
  the default.
- **CLI help** in `src/index.ts` (the `slot <n> assign` synopsis) mentions
  the `--machine` flag and notes the federated default behaviour.
- **Tests** in `src/slots/index.test.ts`:
  1. Federated config with self-match → slot data's `machine` equals the
     current machine name.
  2. Federated config without self-match but with a leader → slot data's
     `machine` equals the leader name; stderr warning observed.
  3. Non-federated config → slot data's `machine` is `null` (regression
     pin for current behaviour).
- **Verification**: `bun run typecheck && bun run lint && bun run build &&
  bun test` all pass. Existing `"remote slot dispatch via HTTP"` tests
  (which pass an explicit `--machine`) continue to pass unchanged.

## Context

**Bug site**: `slotAssign` in `src/slots/index.ts` builds a `SlotData`
object whose `machine` field is set as `machine: machine || null`. The
CLI dispatcher (in the same file's argv handling for `slot <n> assign`)
reads `--machine` via `args[++i] ?? ""`, so omitted-flag becomes empty
string, which `||` collapses to `null`.

**Helpers (all already exported from `src/cluster.ts`)**:

- `clusterEnabled()` — returns `true` iff `transport !== "local"` and
  `cluster.machines.length > 0`.
- `clusterCurrentMachineName()` — returns the current node's configured
  name (matches `hostnameTailscale()` and `hostname` against each
  `machines[].host`/`.name`), or `null` if no match.
- `resolveController()` — returns the `ClusterMachine` with
  `role: "leader"`, or `null`.

**Circular-import constraint**: `src/slots/index.ts` already pulls
`clusterIsController` and `clusterCurrentMachineName` via a function-body
`require("../cluster.ts")` to avoid a known circular dep. The new helper
must follow the same dynamic-require pattern.

**Dashboard symptom path**: `generateTerminals` resolves
`host = (machine && clusterMachine(machine)?.host) || machine`; when
`machine` is `null`/`""`, `host` is empty and the slot is dropped by the
`if (!host) continue` guard. `lookupSlotOrchestrationLinks` follows the
same null-bail.

**CLI help**: The `slot <n> assign ...` synopsis line in `src/index.ts`
currently does not mention `--machine` at all.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

In `src/slots/index.ts`:

1. Add a module-level helper `defaultAssignMachine(): string | null` that
   uses dynamic `require("../cluster.ts")` (matching the existing
   pattern) to call `clusterEnabled()`, `clusterCurrentMachineName()`,
   and `resolveController()`. Logic:
   - If `!clusterEnabled()` → return `null` (back-compat).
   - Else try `clusterCurrentMachineName()` → return if non-null.
   - Else try `resolveController()?.name` → return with stderr warning.
   - Else return `null` with stderr warning.
2. In `slotAssign`, replace `machine: machine || null` with
   `machine: machine || defaultAssignMachine()`.
3. Update the `slot <n> assign` help line in `src/index.ts` to include
   `[--machine <name>]` and a brief default-behaviour note.

In `src/slots/index.test.ts`:

4. Add a `describe("slotAssign machine default in federated setup", ...)`
   block with the three AC tests. Reuse the existing
   `writeConfig(homeDir, { cluster: true })` helper; for the self-match
   case, add a machines entry whose `host` matches the test runner's
   `os.hostname()` (or use the existing tailscale-host injection if the
   test infra supports it). For the leader-fallback case, use a config
   with no self-match plus a `role: "leader"` machine. The non-federated
   case uses the default `writeConfig(TMP)` and asserts `machine: null`.

## Scope

**In scope**:
- `src/slots/index.ts` — the helper and the call-site swap (~15 LOC).
- `src/slots/index.test.ts` — three new tests in a new describe block
  (~30 LOC).
- `src/index.ts` — one-line CLI help update.

**Out of scope**:
- Remote-dispatch behaviour changes — `ensureRemoteMachineReachable` and
  the `start`/`stop` dispatch paths already respect the slot's stored
  machine and are unaffected by the assign-time default.
- Auto-detection for `slot start` / `slot stop` — they already dispatch
  to the slot's stored machine; no change needed.
- Non-federated default behaviour — stays `null`.
- README updates beyond the inline CLI help.

**Dependencies**: none.
