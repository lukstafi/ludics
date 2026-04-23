# Extract shared `installSimpleTriggers()` in `src/triggers.ts`

## Goal

Deduplicate the four byte-identical `installSimpleTrigger` call sites that
currently exist in both `triggersInstallMacos` and `triggersInstallLinux`
(`startup`, `mag`, `dashboard`, `ntfy-subscribe`) by factoring them into a
single shared `installSimpleTriggers()` function — the same precedent as
`installIntervalTrigger`, which is already shared across both platform
installers. This removes ~40 lines of duplication and keeps the two install
paths focused on their platform-specific blocks (launchd plists on macOS,
systemd units on Linux).

Follow-up to `task-3e21bf8b` (which introduced `installSimpleTrigger`); its
retrospective flagged this exact cleanup.

## Acceptance Criteria

1. A new top-level `installSimpleTriggers()` function exists in
   `src/triggers.ts`, invoked once from `triggersInstallMacos` and once from
   `triggersInstallLinux`. It installs the four simple triggers (`startup`,
   `mag`, `dashboard`, `ntfy-subscribe`) along with their shared
   configuration/prelude reads.
2. The four previously duplicated `installSimpleTrigger(...)` call sites in
   `triggersInstallMacos` and `triggersInstallLinux` are removed.
3. The shared prelude used by the tail three simple triggers is hoisted into
   the extracted function — specifically:
   - `loadConfigSync()` (single config read),
   - `magEnabled` / `keepaliveInterval` / `intervalLabel`,
   - `dashPort` fallback,
   - `incomingTopic` resolution.
4. `installSimpleTrigger` itself is unchanged (it already branches on
   `process.platform === "darwin"` internally).
5. The interleaved platform-specific blocks remain in their respective
   installers: on macOS the morning and health `installPlist` blocks and the
   `for (const rule of triggerGetWatchRules())` plist loop; on Linux the
   morning/health `writeSystemdUnit` calls and the watch-rule path/service
   loop. `installIntervalTrigger` invocations likewise stay in place.
6. `binPath()` is still called where the macOS/Linux installers currently use
   `bin` in their outer scopes (for morning/health/watch blocks). The `bin`
   local that today only served the trailing three simple triggers is no
   longer needed after extraction.
7. Behavior is preserved:
   - The same four triggers are installed/skipped under the same enablement
     conditions (`startup.enabled`, `mag.enabled`, `dashboard.enabled`,
     `!!incomingTopic`).
   - The arguments and log labels emitted by each call match today's output
     (the two incidental comment deltas — `// Startup trigger` vs.
     `// Startup`, `// Dashboard trigger` vs. `// Dashboard` — are unified
     into a single comment in the extracted function).
   - `installPlist` / `enableSystemdUnit` side effects are the same set of
     files on disk.
8. A small reorder is acceptable: with all four simple triggers grouped into
   one call, the `startup` trigger installs at whichever position the
   extracted call is placed (top or bottom of each installer). Install order
   is not semantically significant — each `installPlist` /
   `enableSystemdUnit` operates independently — so this is fine.
9. `bun run build` succeeds and `bun test` passes. No new tests are required
   (there is no existing trigger test suite; `installSimpleTrigger` itself is
   unchanged, so the refactor is test-equivalent by construction).

## Context

All code lives in `src/triggers.ts`.

- `installSimpleTrigger` — the shared helper that branches internally on
  `process.platform === "darwin"` to emit either a launchd plist or a systemd
  service (+ optional activation unit). No change needed here.
- `installIntervalTrigger` — the existing precedent: a single helper called
  identically from both `triggersInstallMacos` and `triggersInstallLinux`
  (e.g., `"sync"`, `"sessions"`, `"sessions-sweep"`, `"t3code-cleanup"`,
  `"cluster"`).
- `triggersInstallMacos` — contains the `// Startup trigger` block at the top
  and the `// Mag keepalive` / `// Dashboard trigger` / `// ntfy-subscribe
  (incoming messages)` tail, with a shared `loadConfigSync()` /
  `magEnabled` / `keepaliveInterval` / `intervalLabel` / `dashPort` /
  `incomingTopic` prelude.
- `triggersInstallLinux` — contains the same startup block (comment reads
  `// Startup`) and the same tail (`// Dashboard` comment) with the same
  prelude.

The four call sites were verified byte-identical (via `diff` of the two
regions in `triggers.ts`) apart from those two comment-text differences. No
other platform-specific wart exists in these blocks.

There are no existing tests that exercise `installSimpleTrigger` or the
install paths (`grep` of `src/` and `test/` finds only `init.ts` and
`triggers.ts` itself referencing these symbols), so the refactor's
correctness rests on preserving the helper's inputs unchanged at each call.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add a new top-level `function installSimpleTriggers(): void { ... }` in
   `src/triggers.ts`. Natural placement: near `installIntervalTrigger`
   (between the two platform installers), mirroring the existing pattern.
2. Body of the new function:
   - Call `binPath()` only if needed internally (the startup block uses `bin`
     in `systemdServiceBody`; keep a local `const bin = binPath();` at the
     top of `installSimpleTriggers`).
   - Install the `startup` trigger (verbatim move of lines 128–136 /
     371–379).
   - Run the shared prelude once:
     `const config = loadConfigSync();`
     `const mag = config.mag as Record<string, unknown> | undefined;`
     `const magEnabled = mag?.enabled;`
     `const keepaliveInterval = String(mag?.keepalive_interval ?? "60");`
     `const magSecs = parseInt(keepaliveInterval);`
     `const intervalLabel = magSecs >= 60 ? \`${Math.floor(magSecs / 60)}m${magSecs % 60 ? magSecs % 60 + "s" : ""}\` : \`${magSecs}s\`;`
     `let dashPort = triggerGet("dashboard", "port");`
     `if (!dashPort) dashPort = String(config.dashboard?.port ?? 7678);`
     `const incomingTopic = config.notifications?.topics?.incoming;`
   - Call `installSimpleTrigger` for `mag`, `dashboard`, `ntfy-subscribe`
     (verbatim move of the existing arguments).
3. In `triggersInstallMacos`: delete the startup block and the tail three
   (together with their shared prelude), and replace with a single
   `installSimpleTriggers();` call. Keep all other blocks
   (morning/health/watch plists, `installIntervalTrigger(...)` calls) in
   place.
4. In `triggersInstallLinux`: same — delete startup block and the tail three
   (and prelude), replace with `installSimpleTriggers();`. Keep
   morning/health/watch systemd units and `installIntervalTrigger(...)`
   calls in place.
5. Remove the now-unused `const bin = binPath();` from each platform
   installer **only if** no remaining block in that installer references
   `bin` — i.e., leave `bin` in place where morning/health/watch still use
   it (currently true on both platforms). In practice this means leaving the
   outer `bin` declaration untouched in both installers.
6. Pick a single comment for the unified startup call (e.g., `// Startup`)
   and a single comment for the dashboard call (e.g., `// Dashboard`),
   resolving the two incidental comment-text deltas.
7. Run `bun run build` and `bun test` to verify no regressions.

## Scope

**In scope**

- Extract `installSimpleTriggers()` in `src/triggers.ts` and route both
  platform installers through it.
- Unify the two incidental comment-text deltas (`// Startup trigger` →
  `// Startup`, `// Dashboard trigger` → `// Dashboard`, or equivalent
  single choice).

**Out of scope**

- No changes to `installSimpleTrigger` itself (its internal platform branch
  stays as-is).
- No changes to `installIntervalTrigger` or to any morning/health/watch
  block.
- No new tests; no change to `init.ts` or any other caller.
- No changes to trigger semantics, enablement conditions, or install
  artifacts.

**Dependencies**

- Relates to `task-3e21bf8b` (which introduced `installSimpleTrigger`); no
  blocking dependency.
