# Remove redundant `network` config key

## Goal

After gh-ludics-258 removed `network.mode`, the `network` config key only holds
an optional `hostname` override. The cluster machine `host` fallback in
`networkHostname()` already covers this use case, making the entire `network`
section redundant. Removing it simplifies the config surface and eliminates a
misleading template entry.

Related: [gh-ludics-258](https://github.com/lukstafi/ludics/issues/258)

## Acceptance Criteria

1. The `network` key and its type are removed from config (`LudicsConfig` type
   in `src/config.ts`).
2. `hostnameFromConfig()` is removed from `src/network.ts`.
3. The hostname fallback chain in `networkHostname()` skips straight from
   tailscale CLI detection to the cluster machine `host` lookup (no behavior
   change for any machine that has a `cluster.machines[]` entry with a `host`
   field).
4. `networkStatus()` no longer displays a "Config hostname" line.
5. The `network:` section is removed from `templates/harness/config.yaml`.
6. The project builds cleanly after changes.

## Context

**Hostname resolution chain** (`networkHostname()` in `src/network.ts:48-71`):
1. `hostnameTailscale()` -- queries tailscale CLI
2. `hostnameFromConfig()` -- reads `config.network.hostname` (being removed)
3. `clusterCurrentMachine()?.host` -- cluster machine config lookup

Step 3 already exists as a fallback. Removing step 2 just tightens the chain.

**Files involved:**
- `src/config.ts:79` -- `network?: { hostname?: string }` in `LudicsConfig`
- `src/network.ts:11-14` -- `hostnameFromConfig()` function
- `src/network.ts:57-58` -- call site in `networkHostname()`
- `src/network.ts:99-102` -- display in `networkStatus()`
- `templates/harness/config.yaml:125-129` -- template `network:` section

**User's own harness config** does not use the `network:` key, confirming it is
unused in practice.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

Straightforward deletion: remove the type field, the helper function, its two
call sites, and the template section. No new code needed.

## Scope

**In scope:** Removal of the `network` config key, its type, helper function,
call sites, and template documentation.

**Out of scope:** Changes to cluster hostname resolution, tailscale detection,
or any other network functionality. No migration or deprecation warning needed
since the field was optional and unused.

**Dependencies:** None (gh-ludics-258 is already completed).
